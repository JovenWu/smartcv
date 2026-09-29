import re

from typesafe_sdk import AsyncTypeSafeClient, Choice, Score

from backend.app.config import Settings
from backend.app.documents import prepare_evaluation_spans
from backend.app.schemas import (
    Criterion,
    CriterionEvaluation,
    CriterionInput,
    EvidenceSpan,
    MatchStatus,
    WeightSuggestion,
)

NO_MATCH = "no_match"

_MATCH_FRACTIONS = [0.0, 0.5, 1.0]
_MATCH_STATUSES = [
    MatchStatus.NOT_FOUND,
    MatchStatus.PARTIAL,
    MatchStatus.STRONG,
]

_MATCH_LEVELS = [
    "No relevant evidence in the CV supports this criterion.",
    "Partial or indirect evidence supports some parts of the criterion.",
    "Clear direct or equivalent evidence supports the criterion.",
]

_WEIGHT_LEVELS = [
    "Trivially related to the role; nice to mention but carries almost no importance.",
    "Minor supporting skill; helpful but far from essential.",
    "Moderately important; expected but not a core requirement.",
    "Important; a core part of the role's day-to-day work.",
    "Critical; the role cannot be performed well without it.",
]


class RetryableEvaluationError(Exception):
    """The evaluation service failed; the candidate may be retried later."""


class TypeSafeEvaluator:
    def __init__(self, client, review_threshold: float) -> None:
        self.client = client
        self.review_threshold = review_threshold

    async def suggest_weights(
        self, criteria: list[CriterionInput]
    ) -> list[WeightSuggestion]:
        questions = {
            f"weight_{criterion.id}": Score(
                instructions=(
                    "How important is this criterion for success in the role? "
                    "Judge only job-related importance."
                ),
                criteria=list(_WEIGHT_LEVELS),
            )
            for criterion in criteria
        }
        try:
            result = await self.client.system_one(
                state={
                    "criteria": [
                        criterion.model_dump(mode="json") for criterion in criteria
                    ]
                },
                questions=questions,
            )
        except Exception as error:
            raise RetryableEvaluationError(
                f"Evaluation service request failed ({type(error).__name__})"
            ) from error
        return [
            WeightSuggestion(
                criterion_id=criterion.id,
                proposed_weight=max(
                    1,
                    min(
                        5,
                        int(
                            result.scores[f"weight_{criterion.id}"].score + 0.5
                        )
                        + 1,
                    ),
                ),
                confidence=min(
                    1.0,
                    max(
                        0.0,
                        result.scores[f"weight_{criterion.id}"].confidence,
                    ),
                ),
            )
            for criterion in criteria
        ]

    async def evaluate_candidate(
        self, criteria: list[Criterion], spans: list[EvidenceSpan]
    ) -> list[CriterionEvaluation]:
        evaluation_spans = prepare_evaluation_spans(spans)
        questions = {}
        for criterion in criteria:
            questions[f"score_{criterion.id}"] = Score(
                instructions=(
                    f"How strongly does the CV evidence meet this requirement: "
                    f"{criterion.name} — {criterion.description}. Assess only "
                    f"job-related evidence and ignore personal identity or "
                    f"demographic characteristics."
                ),
                criteria=list(_MATCH_LEVELS),
            )
            questions[f"evidence_{criterion.id}"] = Choice(
                instructions=(
                    f"Which span best supports this requirement: "
                    f"{criterion.name} — {criterion.description}. Choose "
                    f"{NO_MATCH} if none does."
                ),
                criteria={
                    **{
                        span.id: f"Page {span.page_number}: {span.text}"
                        for span in evaluation_spans
                    },
                    NO_MATCH: "No listed span supports the requirement.",
                },
            )
        try:
            result = await self.client.system_one(
                state={
                    "criteria": [
                        {
                            "id": criterion.id,
                            "name": criterion.name,
                            "description": criterion.description,
                        }
                        for criterion in criteria
                    ],
                    "spans": [
                        span.model_dump(mode="json") for span in evaluation_spans
                    ],
                },
                questions=questions,
            )
        except Exception as error:
            raise RetryableEvaluationError(
                f"Evaluation service request failed ({type(error).__name__})"
            ) from error

        source_by_id = {span.id: span for span in spans}
        evaluations = []
        for criterion in criteria:
            score_answer = result.scores[f"score_{criterion.id}"]
            evidence_answer = result.choices[f"evidence_{criterion.id}"]
            level_index = int(
                max(
                    score_answer.probabilities,
                    key=lambda level: score_answer.probabilities[level],
                )
            )
            level_index = max(0, min(2, level_index))
            fraction = _MATCH_FRACTIONS[level_index]
            status = _MATCH_STATUSES[level_index]
            selected = evidence_answer.choice
            confidence = min(score_answer.confidence, evidence_answer.confidence)
            confidence = min(1.0, max(0.0, confidence))
            cited = source_by_id.get(selected) if selected != NO_MATCH else None
            inconsistent = (
                (selected == NO_MATCH and status != MatchStatus.NOT_FOUND)
                or (selected != NO_MATCH and status == MatchStatus.NOT_FOUND)
                or (selected != NO_MATCH and cited is None)
            )
            if confidence <= self.review_threshold or inconsistent:
                status = MatchStatus.NEEDS_REVIEW
            evaluations.append(
                CriterionEvaluation(
                    criterion_id=criterion.id,
                    status=status,
                    confidence=confidence,
                    model_fraction=fraction,
                    evidence_span_id=cited.id if cited else None,
                )
            )
        return evaluations


_WORD = re.compile(r"[a-zA-Z]{3,}")
_STOPWORDS = {
    "and", "the", "with", "from", "that", "this", "have", "has", "for",
    "you", "your", "are", "our", "their", "show", "use", "work",
}


class FakeEvaluator:
    """Deterministic offline evaluator for explicit synthetic demos."""

    def __init__(self, review_threshold: float = 0.5) -> None:
        self.review_threshold = review_threshold

    async def suggest_weights(
        self, criteria: list[CriterionInput]
    ) -> list[WeightSuggestion]:
        return [
            WeightSuggestion(
                criterion_id=criterion.id, proposed_weight=3, confidence=1.0
            )
            for criterion in criteria
        ]

    async def evaluate_candidate(
        self, criteria: list[Criterion], spans: list[EvidenceSpan]
    ) -> list[CriterionEvaluation]:
        evaluations = []
        for criterion in criteria:
            keywords = {
                word
                for word in _WORD.findall(
                    f"{criterion.id} {criterion.name} {criterion.description}".lower()
                )
                if word not in _STOPWORDS
            }
            best_span = None
            best_hits = 0
            for span in spans:
                text = span.text.lower()
                hits = sum(1 for keyword in keywords if keyword in text)
                if hits > best_hits:
                    best_span = span
                    best_hits = hits
            if best_hits >= 2:
                status, fraction = MatchStatus.STRONG, 1.0
            elif best_hits == 1:
                status, fraction = MatchStatus.PARTIAL, 0.5
            else:
                status, fraction = MatchStatus.NOT_FOUND, 0.0
            evaluations.append(
                CriterionEvaluation(
                    criterion_id=criterion.id,
                    status=status,
                    confidence=0.95,
                    model_fraction=fraction,
                    evidence_span_id=best_span.id if best_span else None,
                )
            )
        return evaluations


def create_evaluator(settings: Settings):
    """Build the evaluator for the app lifespan.

    Returns (evaluator, client); client is None for the fake evaluator and
    must be closed by the caller otherwise.
    """
    if settings.smartcv_fake_evaluator:
        return FakeEvaluator(settings.review_confidence_threshold), None
    if settings.typesafe_api_key is None:
        raise RuntimeError(
            "TYPESAFE_API_KEY is required unless SMARTCV_FAKE_EVALUATOR=true"
        )
    client = AsyncTypeSafeClient(
        api_key=settings.typesafe_api_key.get_secret_value(),
        model=settings.typesafe_model,
    )
    return TypeSafeEvaluator(client, settings.review_confidence_threshold), client
