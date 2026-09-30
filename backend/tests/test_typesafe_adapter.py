from types import SimpleNamespace

import pytest

from backend.app.schemas import (
    CriteriaSuggestionRequest,
    Criterion,
    CriterionInput,
    CriterionRef,
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


def noul_answer(probability):
    return SimpleNamespace(noul=probability)


class FakeClient:
    """Records calls and returns canned answers keyed by question id."""

    def __init__(self, scores=None, choices=None, nouls=None, error=None):
        self.scores = scores or {}
        self.choices = choices or {}
        self.nouls = nouls or {}
        self.error = error
        self.calls = []

    async def system_one(self, state, questions):
        from typesafe_sdk import Choice, Noul, Score

        self.calls.append({"state": state, "questions": questions})
        if self.error is not None:
            raise self.error
        scores, choices, nouls = {}, {}, {}
        for key, question in questions.items():
            if isinstance(question, Score):
                scores[key] = self.scores.get(
                    key, score_answer({"0": 0.1, "1": 0.1, "2": 0.8})
                )
            elif isinstance(question, Choice):
                choices[key] = self.choices.get(key, choice_answer("no_match"))
            elif isinstance(question, Noul):
                nouls[key] = self.nouls.get(key, noul_answer(0.5))
        return SimpleNamespace(
            scores=scores, choices=choices, nouls=nouls
        )


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


async def test_suggest_criteria_maps_skill_to_existing_criterion():
    client = FakeClient(
        choices={"match_0": choice_answer("python")},
        scores={"weight_0": score_answer({"0": 0, "1": 0, "2": 0, "3": 0, "4": 1})},
        nouls={"required_0": noul_answer(0.9)},
    )
    evaluator = TypeSafeEvaluator(client=client, review_threshold=0.5)
    request = CriteriaSuggestionRequest(
        title="Backend Engineer",
        skills=["Python"],
        existing_criteria=[
            CriterionRef(id="python", name="Python"),
            CriterionRef(id="db", name="Databases"),
        ],
    )
    suggestions = await evaluator.suggest_criteria(request)
    assert len(suggestions) == 1
    assert suggestions[0].skill == "Python"
    assert suggestions[0].matched_criterion_id == "python"
    assert suggestions[0].criterion is None


async def test_suggest_criteria_proposes_new_criterion():
    client = FakeClient(
        choices={"match_0": choice_answer("new")},
        scores={"weight_0": score_answer({"0": 0, "1": 0, "2": 0, "3": 0.9, "4": 0.1})},
        nouls={"required_0": noul_answer(0.8)},
    )
    evaluator = TypeSafeEvaluator(client=client, review_threshold=0.5)
    request = CriteriaSuggestionRequest(
        title="Backend Engineer",
        department="Engineering",
        skills=["Kubernetes"],
        existing_criteria=[CriterionRef(id="python", name="Python")],
    )
    suggestions = await evaluator.suggest_criteria(request)
    assert len(suggestions) == 1
    suggestion = suggestions[0]
    assert suggestion.matched_criterion_id is None
    criterion = suggestion.criterion
    assert criterion is not None
    assert criterion.name == "Kubernetes"
    assert criterion.suggested_weight == 4
    assert criterion.required is True
    assert 0.0 <= criterion.confidence <= 1.0


async def test_suggest_criteria_sends_role_context_in_state():
    client = FakeClient()
    evaluator = TypeSafeEvaluator(client=client, review_threshold=0.5)
    request = CriteriaSuggestionRequest(
        title="Backend Engineer",
        department="Platform",
        employment_type="full_time",
        skills=["Go"],
        existing_criteria=[CriterionRef(id="python", name="Python")],
    )
    await evaluator.suggest_criteria(request)
    call = client.calls[0]
    state = call["state"]
    assert state["title"] == "Backend Engineer"
    assert state["department"] == "Platform"
    assert state["employment_type"] == "full_time"
    assert state["existing_criteria"] == [{"id": "python", "name": "Python"}]
    assert set(call["questions"]) == {"match_0", "weight_0", "required_0"}
    match_criteria = call["questions"]["match_0"].criteria
    assert "python" in match_criteria
    assert "new" in match_criteria


async def test_suggest_criteria_with_no_skills_returns_empty():
    client = FakeClient()
    evaluator = TypeSafeEvaluator(client=client, review_threshold=0.5)
    suggestions = await evaluator.suggest_criteria(
        CriteriaSuggestionRequest(title="Role", skills=[])
    )
    assert suggestions == []
    assert client.calls == []


async def test_evaluate_candidate_sends_opening_context(evaluator):
    from datetime import datetime, timezone

    from backend.app.schemas import Opening

    opening = Opening(
        id="o1",
        title="Backend Engineer",
        department="Platform",
        description="Build backend APIs.",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    await evaluator.evaluate_candidate(CRITERIA, SPANS, opening)
    state = evaluator.client.calls[0]["state"]
    assert state["opening"]["title"] == "Backend Engineer"
    assert state["opening"]["department"] == "Platform"
    assert state["opening"]["description"] == "Build backend APIs."


async def test_service_error_becomes_retryable():
    evaluator = TypeSafeEvaluator(
        client=FakeClient(error=RuntimeError("boom")), review_threshold=0.5
    )
    with pytest.raises(RetryableEvaluationError):
        await evaluator.evaluate_candidate(CRITERIA, SPANS)
