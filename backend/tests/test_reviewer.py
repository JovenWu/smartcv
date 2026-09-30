import json
from datetime import datetime, timezone

import httpx

from backend.app.config import Settings
from backend.app.reviewer import LlmReviewer, create_reviewer
from backend.app.schemas import (
    Criterion,
    CriterionEvaluation,
    EvidenceSpan,
    MatchStatus,
    Opening,
)

CRITERIA = [
    Criterion(
        id="python",
        name="Python",
        description="Build Python services.",
        weight=5,
    ),
    Criterion(
        id="db",
        name="Databases",
        description="Use PostgreSQL.",
        weight=3,
    ),
]

SPANS = [
    EvidenceSpan(id="p1-b0", page_number=1, text="Built Python APIs."),
    EvidenceSpan(id="p1-b1", page_number=1, text="Used PostgreSQL daily."),
]

FLAGGED = [
    CriterionEvaluation(
        criterion_id="python",
        status=MatchStatus.NEEDS_REVIEW,
        confidence=0.2,
        model_fraction=0.5,
    ),
    CriterionEvaluation(
        criterion_id="db",
        status=MatchStatus.NEEDS_REVIEW,
        confidence=0.3,
        model_fraction=0.0,
    ),
]


def make_settings(**overrides):
    base = {"_env_file": None, "openrouter_api_key": "k"}
    base.update(overrides)
    return Settings(**base)


def openrouter_response(payload):
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": json.dumps(payload)}}]
        },
    )


def make_reviewer(handler, **settings):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return LlmReviewer(make_settings(**settings), client), client


async def test_decisive_verdicts_resolve_flagged_cells():
    def handler(request):
        return openrouter_response(
            {
                "evaluations": [
                    {
                        "criterionId": "python",
                        "matchLevel": "strong",
                        "evidenceSpanId": "p1-b0",
                        "confidence": 0.92,
                        "rationale": "Direct Python API work cited.",
                    },
                    {
                        "criterionId": "db",
                        "matchLevel": "not_found",
                        "evidenceSpanId": None,
                        "confidence": 0.88,
                        "rationale": "No database evidence in the CV.",
                    },
                ]
            }
        )

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert resolved["python"].status == MatchStatus.STRONG
    assert resolved["python"].model_fraction == 1.0
    assert resolved["python"].evidence_span_ids == ["p1-b0"]
    assert resolved["python"].confidence == 0.92
    assert resolved["python"].rationale == "Direct Python API work cited."
    assert resolved["db"].status == MatchStatus.NOT_FOUND
    assert resolved["db"].model_fraction == 0.0
    assert resolved["db"].evidence_span_ids == []
    await client.aclose()


async def test_low_llm_confidence_stays_flagged_but_keeps_rationale():
    def handler(request):
        return openrouter_response(
            {
                "evaluations": [
                    {
                        "criterionId": "python",
                        "matchLevel": "partial",
                        "evidenceSpanId": "p1-b0",
                        "confidence": 0.4,
                        "rationale": "Indirect mention only.",
                    }
                ]
            }
        )

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert resolved["python"].status == MatchStatus.NEEDS_REVIEW
    assert resolved["python"].model_fraction == 0.5
    assert resolved["python"].rationale == "Indirect mention only."
    assert "db" not in resolved
    await client.aclose()


async def test_verdict_with_inconsistent_span_stays_flagged():
    def handler(request):
        return openrouter_response(
            {
                "evaluations": [
                    {
                        "criterionId": "python",
                        "matchLevel": "strong",
                        "evidenceSpanId": "p9-b9",
                        "confidence": 0.95,
                        "rationale": "Cited a fabricated span.",
                    },
                    {
                        "criterionId": "db",
                        "matchLevel": "strong",
                        "evidenceSpanId": None,
                        "confidence": 0.95,
                        "rationale": "No citation for a positive verdict.",
                    },
                ]
            }
        )

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert resolved["python"].status == MatchStatus.NEEDS_REVIEW
    assert resolved["db"].status == MatchStatus.NEEDS_REVIEW
    await client.aclose()


async def test_provider_failure_returns_nothing():
    def handler(request):
        return httpx.Response(500)

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert resolved == {}
    await client.aclose()


async def test_malformed_content_returns_nothing():
    def handler(request):
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "not json"}}]},
        )

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert resolved == {}
    await client.aclose()


async def test_request_carries_opening_masked_spans_and_first_pass():
    captured = {}

    def handler(request):
        captured.update(json.loads(request.content))
        return openrouter_response({"evaluations": []})

    opening = Opening(
        id="o1",
        title="Backend Engineer",
        department="Platform",
        description="Build backend APIs.",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    spans = [
        EvidenceSpan(
            id="p1-b0",
            page_number=1,
            text="Jane Doe\nemail: jane@x.com\nBuilt Python APIs.",
        )
    ]
    reviewer, client = make_reviewer(handler)
    await reviewer.review(
        opening=opening, criteria=CRITERIA, flagged=FLAGGED, spans=spans
    )

    assert captured["model"] == "openai/gpt-6-luna"
    assert (
        captured["response_format"]["json_schema"]["strict"] is True
    )
    user_message = json.loads(captured["messages"][1]["content"])
    assert user_message["opening"]["title"] == "Backend Engineer"
    assert user_message["opening"]["department"] == "Platform"
    texts = [s["text"] for s in user_message["spans"]]
    assert any("Built Python APIs" in text for text in texts)
    assert "jane@x.com" not in str(texts)
    flagged = {c["id"]: c for c in user_message["criteria"]}
    assert flagged["python"]["firstPass"]["confidence"] == 0.2
    assert flagged["db"]["firstPass"]["matchLevel"] == "not_found"
    await client.aclose()


async def test_response_skipping_a_criterion_leaves_it_untouched():
    def handler(request):
        return openrouter_response(
            {
                "evaluations": [
                    {
                        "criterionId": "python",
                        "matchLevel": "strong",
                        "evidenceSpanId": "p1-b0",
                        "confidence": 0.9,
                        "rationale": "Confirmed.",
                    }
                ]
            }
        )

    reviewer, client = make_reviewer(handler)
    resolved = await reviewer.review(
        opening=None, criteria=CRITERIA, flagged=FLAGGED, spans=SPANS
    )
    assert set(resolved) == {"python"}
    await client.aclose()


async def test_create_reviewer_gating():
    reviewer, client = create_reviewer(
        make_settings(openrouter_api_key=None)
    )
    assert reviewer is None and client is None

    reviewer, client = create_reviewer(
        make_settings(escalation_enabled=False)
    )
    assert reviewer is None and client is None

    reviewer, client = create_reviewer(make_settings())
    assert isinstance(reviewer, LlmReviewer)
    assert client is not None
    await client.aclose()
