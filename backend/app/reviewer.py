"""Second-pass review: escalate Jev's needs_review cells to a reasoning
model (OpenRouter chat completions) that can weigh the full CV evidence.

Escalation only ever touches flagged cells — failures leave the original
verdicts untouched, so the human review queue is the fallback.
"""

import json
import logging

import httpx

from backend.app.config import Settings
from backend.app.documents import prepare_evaluation_spans
from backend.app.schemas import (
    Criterion,
    CriterionEvaluation,
    EvidenceSpan,
    MatchStatus,
    Opening,
)

log = logging.getLogger(__name__)

_STATUS_BY_LEVEL = {
    "not_found": MatchStatus.NOT_FOUND,
    "partial": MatchStatus.PARTIAL,
    "strong": MatchStatus.STRONG,
}
_FRACTION_BY_LEVEL = {"not_found": 0.0, "partial": 0.5, "strong": 1.0}
_LEVEL_BY_FRACTION = {0.0: "not_found", 0.5: "partial", 1.0: "strong"}

# OpenAI strict mode (used by the gpt-6-luna provider) requires `required`
# to list every property; optional fields stay nullable instead.
REVIEW_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["evaluations"],
    "properties": {
        "evaluations": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "criterionId",
                    "matchLevel",
                    "evidenceSpanId",
                    "confidence",
                    "rationale",
                ],
                "properties": {
                    "criterionId": {"type": "string"},
                    "matchLevel": {
                        "type": "string",
                        "enum": ["not_found", "partial", "strong"],
                    },
                    "evidenceSpanId": {"type": ["string", "null"]},
                    "confidence": {"type": "number"},
                    "rationale": {"type": "string"},
                },
            },
        }
    },
}

_REVIEW_PROMPT = (
    "You are the second-pass reviewer for a CV screening tool. The first "
    "pass flagged each listed criterion as uncertain; re-judge it "
    "against the CV evidence spans using the role context. Rules: "
    "matchLevel is 'strong' for clear direct evidence, 'partial' for "
    "indirect or incomplete evidence, 'not_found' when no span supports "
    "the criterion; cite the best evidenceSpanId for strong/partial and "
    "null for not_found; confidence is your certainty in the verdict "
    "between 0 and 1 — report a low value when the evidence is genuinely "
    "ambiguous rather than guessing; rationale is one sentence a "
    "recruiter can act on. Judge only job-related evidence; ignore "
    "personal identity or demographic details. Return one entry per "
    "listed criterion."
)


class LlmReviewer:
    """Escalates flagged criterion verdicts to the OpenRouter model."""

    def __init__(
        self, settings: Settings, client: httpx.AsyncClient
    ) -> None:
        self.settings = settings
        self.client = client

    async def review(
        self,
        *,
        opening: Opening | None,
        criteria: list[Criterion],
        flagged: list[CriterionEvaluation],
        spans: list[EvidenceSpan],
    ) -> dict[str, CriterionEvaluation]:
        """Resolved or annotated evaluations keyed by criterion id.

        Flagged cells the model omits or cannot decide confidently are
        absent from the result — the caller keeps the original
        needs_review verdict.
        """
        flagged_by_id = {e.criterion_id: e for e in flagged}
        criteria_by_id = {c.id: c for c in criteria}
        evaluation_spans = prepare_evaluation_spans(spans)
        criteria_payload = []
        for evaluation in flagged:
            criterion = criteria_by_id.get(evaluation.criterion_id)
            if criterion is None:
                continue
            criteria_payload.append(
                {
                    "id": criterion.id,
                    "name": criterion.name,
                    "description": criterion.description,
                    "required": criterion.required,
                    "firstPass": {
                        "matchLevel": _LEVEL_BY_FRACTION.get(
                            evaluation.model_fraction
                        ),
                        "confidence": evaluation.confidence,
                        "evidenceSpanId": (
                            evaluation.evidence_span_ids[0]
                            if evaluation.evidence_span_ids
                            else None
                        ),
                    },
                }
            )
        if not criteria_payload:
            return {}
        user_message = {
            "opening": (
                {
                    "title": opening.title,
                    "department": opening.department,
                    "location": opening.location,
                    "description": opening.description,
                    "experienceLevel": opening.experience_level,
                    "educationLevel": opening.education_level,
                }
                if opening is not None
                else None
            ),
            "criteria": criteria_payload,
            "spans": [
                span.model_dump(mode="json") for span in evaluation_spans
            ],
        }
        try:
            response = await self.client.post(
                f"{self.settings.openrouter_base_url}/chat/completions",
                headers={
                    "Authorization": (
                        "Bearer "
                        + self.settings.openrouter_api_key.get_secret_value()
                    ),
                },
                json={
                    "model": self.settings.openrouter_model,
                    "messages": [
                        {"role": "system", "content": _REVIEW_PROMPT},
                        {
                            "role": "user",
                            "content": json.dumps(
                                user_message, separators=(",", ":")
                            ),
                        },
                    ],
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "criterion_review",
                            "strict": True,
                            "schema": REVIEW_SCHEMA,
                        },
                    },
                    "max_tokens": 8000,
                },
                timeout=self.settings.escalation_timeout,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
        except Exception as error:
            # Escalation must never break the pipeline — any failure
            # (HTTP, timeout, malformed JSON) leaves the flags in place.
            log.warning("Second-pass review failed: %r", error)
            return {}
        return self._resolve(
            data, flagged_by_id, {s.id for s in evaluation_spans}
        )

    def _resolve(
        self,
        data: dict,
        flagged_by_id: dict[str, CriterionEvaluation],
        span_ids: set[str],
    ) -> dict[str, CriterionEvaluation]:
        resolved = {}
        items = data.get("evaluations") if isinstance(data, dict) else []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            criterion_id = item.get("criterionId")
            original = flagged_by_id.get(criterion_id)
            if original is None:
                continue
            level = item.get("matchLevel")
            confidence = item.get("confidence")
            evidence_id = item.get("evidenceSpanId")
            rationale = str(item.get("rationale") or "").strip() or None
            decisive = (
                level in _STATUS_BY_LEVEL
                and isinstance(confidence, (int, float))
                and not isinstance(confidence, bool)
                and confidence >= self.settings.escalation_min_confidence
                # Same consistency rule as the first pass: a positive
                # verdict must cite a real span, not_found must not.
                and (level == "not_found") == (evidence_id is None)
                and (evidence_id is None or evidence_id in span_ids)
            )
            if decisive:
                resolved[criterion_id] = CriterionEvaluation(
                    criterion_id=criterion_id,
                    status=_STATUS_BY_LEVEL[level],
                    confidence=min(1.0, max(0.0, float(confidence))),
                    model_fraction=_FRACTION_BY_LEVEL[level],
                    evidence_span_ids=[evidence_id] if evidence_id else [],
                    rationale=rationale,
                )
            else:
                # Keep the flag, but surface the model's reasoning so
                # the human reviewer doesn't start from scratch.
                resolved[criterion_id] = original.model_copy(
                    update={"rationale": rationale}
                )
        return resolved


def create_reviewer(settings: Settings):
    """Build the second-pass reviewer for the app lifespan.

    Returns (reviewer, client); both None when escalation is disabled or
    no OpenRouter key is configured. The caller closes the client.
    """
    if (
        not settings.escalation_enabled
        or settings.openrouter_api_key is None
    ):
        return None, None
    client = httpx.AsyncClient()
    return LlmReviewer(settings, client), client
