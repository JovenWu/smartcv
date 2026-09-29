from types import SimpleNamespace

import pytest

from backend.app.schemas import (
    Criterion,
    CriterionInput,
    EvidenceSpan,
    MatchStatus,
)
from backend.app.typesafe_adapter import (
    RetryableEvaluationError,
    TypeSafeEvaluator,
)

CRITERIA = [
    Criterion(id="python", name="Python", description="Build Python services.", weight=5),
    Criterion(id="db", name="Databases", description="Use PostgreSQL.", weight=3),
]

SPANS = [
    EvidenceSpan(id="p1-b0", page_number=1, text="Built Python APIs."),
    EvidenceSpan(id="p1-b1", page_number=1, text="Used PostgreSQL daily."),
]


def score_answer(probabilities, confidence=0.9):
    score = sum(int(level) * p for level, p in probabilities.items())
    return SimpleNamespace(
        probabilities=probabilities, score=score, confidence=confidence
    )


def choice_answer(choice, confidence=0.9):
    return SimpleNamespace(choice=choice, confidence=confidence)


class FakeClient:
    """Records calls and returns canned answers keyed by question id."""

    def __init__(self, scores=None, choices=None, error=None):
        self.scores = scores or {}
        self.choices = choices or {}
        self.error = error
        self.calls = []

    async def system_one(self, state, questions):
        from typesafe_sdk import Choice, Score

        self.calls.append({"state": state, "questions": questions})
        if self.error is not None:
            raise self.error
        scores, choices = {}, {}
        for key, question in questions.items():
            if isinstance(question, Score):
                scores[key] = self.scores.get(
                    key, score_answer({"0": 0.1, "1": 0.1, "2": 0.8})
                )
            elif isinstance(question, Choice):
                choices[key] = self.choices.get(key, choice_answer("no_match"))
        return SimpleNamespace(scores=scores, choices=choices)


@pytest.fixture
def evaluator():
    return TypeSafeEvaluator(client=FakeClient(), review_threshold=0.5)


async def test_suggest_weights_maps_score_to_integer_weight():
    client = FakeClient(
        scores={
            "weight_python": score_answer({"0": 0.0, "1": 0.0, "2": 0.0, "3": 0.1, "4": 0.9}),
            "weight_db": score_answer({"0": 0.7, "1": 0.2, "2": 0.1, "3": 0.0, "4": 0.0}),
        }
    )
    evaluator = TypeSafeEvaluator(client=client, review_threshold=0.5)
    suggestions = await evaluator.suggest_weights(
        [CriterionInput(id=c.id, name=c.name, description=c.description) for c in CRITERIA]
    )
    by_id = {s.criterion_id: s for s in suggestions}
    assert by_id["python"].proposed_weight == 5
    assert by_id["db"].proposed_weight == 1
    assert all(1 <= s.proposed_weight <= 5 for s in suggestions)
    assert all(0.0 <= s.confidence <= 1.0 for s in suggestions)
    assert len(client.calls) == 1


async def test_strong_match_selects_source_span(evaluator):
    evaluator.client.choices["evidence_python"] = choice_answer("p1-b0")
    evaluator.client.choices["evidence_db"] = choice_answer("p1-b1")
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.STRONG
    assert by_id["python"].model_fraction == 1.0
    assert by_id["python"].evidence_span_ids == ["p1-b0"]
    assert by_id["db"].status == MatchStatus.STRONG


async def test_no_match_with_level_zero_is_not_found(evaluator):
    evaluator.client.scores["score_python"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    assert all(e.status == MatchStatus.NOT_FOUND for e in results)
    assert all(e.model_fraction == 0.0 for e in results)
    assert all(e.evidence_span_ids == [] for e in results)


async def test_partial_level_maps_to_half_fraction(evaluator):
    evaluator.client.scores["score_python"] = score_answer({"0": 0.1, "1": 0.8, "2": 0.1})
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    evaluator.client.choices["evidence_python"] = choice_answer("p1-b0")
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.PARTIAL
    assert by_id["python"].model_fraction == 0.5


async def test_low_confidence_is_flagged_for_review(evaluator):
    evaluator.client.scores["score_python"] = score_answer(
        {"0": 0.0, "1": 0.1, "2": 0.9}, confidence=0.2
    )
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    evaluator.client.choices["evidence_python"] = choice_answer("p1-b0", confidence=0.9)
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.NEEDS_REVIEW
    assert by_id["python"].model_fraction == 1.0
    assert by_id["python"].confidence == 0.2
    assert by_id["db"].status == MatchStatus.NOT_FOUND


async def test_contradictory_choice_and_score_is_flagged(evaluator):
    evaluator.client.scores["score_python"] = score_answer({"0": 0.0, "1": 0.1, "2": 0.9})
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    evaluator.client.choices["evidence_python"] = choice_answer("no_match")
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.NEEDS_REVIEW
    assert by_id["python"].model_fraction == 1.0
    assert by_id["python"].evidence_span_ids == []


async def test_span_selected_while_not_found_is_flagged(evaluator):
    evaluator.client.scores["score_python"] = score_answer({"0": 0.95, "1": 0.05, "2": 0.0})
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    evaluator.client.choices["evidence_python"] = choice_answer("p1-b0")
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.NEEDS_REVIEW


async def test_unknown_span_id_is_flagged(evaluator):
    evaluator.client.choices["evidence_python"] = choice_answer("p9-b9")
    evaluator.client.choices["evidence_db"] = choice_answer("no_match")
    evaluator.client.scores["score_db"] = score_answer({"0": 0.9, "1": 0.1, "2": 0.0})
    results = await evaluator.evaluate_candidate(CRITERIA, SPANS)
    by_id = {e.criterion_id: e for e in results}
    assert by_id["python"].status == MatchStatus.NEEDS_REVIEW
    assert by_id["python"].evidence_span_ids == []


async def test_request_contains_masked_spans_and_no_match_option(evaluator):
    spans = [
        EvidenceSpan(
            id="p1-b0",
            page_number=1,
            text="Alex Example\nemail: a@b.com\nBuilt Python APIs.",
        )
    ]
    await evaluator.evaluate_candidate(CRITERIA[:1], spans)
    call = evaluator.client.calls[0]
    assert set(call["questions"]) == {"score_python", "evidence_python"}
    state_spans = call["state"]["spans"]
    assert "a@b.com" not in str(state_spans)
    assert "email:" not in str(state_spans)
    assert "Built Python APIs" in str(state_spans)
    choice_criteria = call["questions"]["evidence_python"].criteria
    assert "no_match" in choice_criteria
    assert "p1-b0" in choice_criteria


async def test_service_error_becomes_retryable():
    evaluator = TypeSafeEvaluator(
        client=FakeClient(error=RuntimeError("boom")), review_threshold=0.5
    )
    with pytest.raises(RetryableEvaluationError):
        await evaluator.evaluate_candidate(CRITERIA, SPANS)
