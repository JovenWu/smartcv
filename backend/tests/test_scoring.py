from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.app.schemas import (
    CandidateResult,
    CandidateStatus,
    Criterion,
    CriterionEvaluation,
    MatchStatus,
)
from backend.app.scoring import (
    STATUS_FRACTION,
    calculate_total_score,
    effective_fraction,
    effective_fractions,
    rank_candidates,
)


def make_candidate(
    candidate_id="c1",
    upload_order=0,
    status=CandidateStatus.COMPLETE,
    total_score=0.0,
):
    return CandidateResult(
        id=candidate_id,
        filename=f"{candidate_id}.pdf",
        upload_order=upload_order,
        status=status,
        evaluations=[],
        total_score=total_score,
        error_message=None,
        retryable=False,
    )


def make_evaluation(
    criterion_id="python",
    status=MatchStatus.STRONG,
    model_fraction=1.0,
    manual_fraction=None,
):
    return CriterionEvaluation(
        criterion_id=criterion_id,
        status=status,
        confidence=0.9,
        model_fraction=model_fraction,
        manual_fraction=manual_fraction,
    )


def test_weighted_total_uses_confirmed_weights():
    weights = {"python": 3, "api_design": 1}
    fractions = {"python": 0.5, "api_design": 1.0}
    assert calculate_total_score(weights, fractions) == 62.5


def test_total_score_is_normalized_to_100():
    weights = {"python": 5, "api_design": 2}
    fractions = {"python": 1.0, "api_design": 1.0}
    assert calculate_total_score(weights, fractions) == 100.0


def test_incomplete_evaluations_have_no_rankable_score():
    assert calculate_total_score({"python": 3}, {}) is None
    assert calculate_total_score({"python": 3, "db": 1}, {"python": 1.0}) is None


def test_non_positive_weight_is_rejected():
    with pytest.raises(ValueError):
        calculate_total_score({"python": 0}, {"python": 1.0})
    with pytest.raises(ValueError):
        calculate_total_score({"python": -1}, {"python": 1.0})


def test_status_fraction_mapping():
    assert STATUS_FRACTION[MatchStatus.STRONG] == 1.0
    assert STATUS_FRACTION[MatchStatus.PARTIAL] == 0.5
    assert STATUS_FRACTION[MatchStatus.NOT_FOUND] == 0.0


def test_manual_fraction_overrides_model_fraction():
    evaluation = SimpleNamespace(model_fraction=0.25, manual_fraction=0.5)
    assert effective_fraction(evaluation) == 0.5


def test_model_fraction_used_without_manual_override():
    evaluation = make_evaluation(model_fraction=0.5)
    assert effective_fraction(evaluation) == 0.5


def test_effective_fractions_collects_per_criterion():
    evaluations = {
        "python": make_evaluation(model_fraction=1.0),
        "db": make_evaluation(criterion_id="db", model_fraction=0.0, manual_fraction=0.5),
    }
    assert effective_fractions(evaluations) == {"python": 1.0, "db": 0.5}


def test_criterion_weight_must_be_between_1_and_5():
    Criterion(id="a", name="A", description="desc", weight=1)
    Criterion(id="a", name="A", description="desc", weight=5)
    with pytest.raises(ValidationError):
        Criterion(id="a", name="A", description="desc", weight=0)
    with pytest.raises(ValidationError):
        Criterion(id="a", name="A", description="desc", weight=6)


def test_fraction_and_confidence_must_be_in_unit_interval():
    with pytest.raises(ValidationError):
        make_evaluation(model_fraction=1.5)
    with pytest.raises(ValidationError):
        make_evaluation(model_fraction=-0.1)
    with pytest.raises(ValidationError):
        make_evaluation(manual_fraction=2.0)
    with pytest.raises(ValidationError):
        CriterionEvaluation(
            criterion_id="x", status=MatchStatus.STRONG,
            confidence=1.1, model_fraction=1.0,
        )


def test_rank_orders_by_descending_score_then_upload_order():
    low = make_candidate("low", upload_order=0, total_score=50.0)
    tied_a = make_candidate("tied-a", upload_order=1, total_score=80.0)
    tied_b = make_candidate("tied-b", upload_order=2, total_score=80.0)
    ranked = rank_candidates([tied_b, low, tied_a])
    assert [c.id for c in ranked] == ["tied-a", "tied-b", "low"]


def test_rank_excludes_unscoreable_and_incomplete_candidates():
    scoreable = make_candidate("ok", upload_order=2, total_score=70.0)
    unscoreable = make_candidate("no-score", upload_order=0, total_score=None)
    failed = make_candidate(
        "failed", upload_order=1, status=CandidateStatus.FAILED, total_score=None
    )
    ranked = rank_candidates([scoreable, unscoreable, failed])
    assert [c.id for c in ranked] == ["ok"]


def test_needs_review_candidate_with_score_is_rankable():
    review = make_candidate(
        "review", upload_order=0,
        status=CandidateStatus.NEEDS_REVIEW, total_score=60.0,
    )
    ranked = rank_candidates([review])
    assert [c.id for c in ranked] == ["review"]
