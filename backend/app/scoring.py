from collections.abc import Mapping, Sequence

from backend.app.schemas import (
    Candidate,
    CandidateStatus,
    CriterionEvaluation,
    MatchStatus,
)

STATUS_FRACTION: dict[MatchStatus, float] = {
    MatchStatus.STRONG: 1.0,
    MatchStatus.PARTIAL: 0.5,
    MatchStatus.NOT_FOUND: 0.0,
}

RANKABLE_STATUSES = {CandidateStatus.COMPLETE, CandidateStatus.NEEDS_REVIEW}


def effective_fraction(evaluation: CriterionEvaluation) -> float:
    if evaluation.manual_fraction is not None:
        return evaluation.manual_fraction
    return evaluation.model_fraction


def effective_fractions(
    evaluations: Mapping[str, CriterionEvaluation],
) -> dict[str, float]:
    return {
        criterion_id: effective_fraction(evaluation)
        for criterion_id, evaluation in evaluations.items()
    }


def calculate_total_score(
    weights: Mapping[str, float],
    fractions: Mapping[str, float],
) -> float | None:
    if not fractions or set(fractions) != set(weights):
        return None
    if any(weight <= 0 for weight in weights.values()):
        raise ValueError("At least one positive criterion weight is required")
    total_weight = sum(weights.values())
    weighted_fraction = sum(
        weights[criterion_id] * fractions[criterion_id]
        for criterion_id in weights
    )
    return round(100 * weighted_fraction / total_weight, 2)


def rank_candidates(
    candidates: Sequence[Candidate],
) -> list[Candidate]:
    rankable = [
        candidate
        for candidate in candidates
        if candidate.total_score is not None
        and candidate.status in RANKABLE_STATUSES
    ]

    def ranking_key(candidate: Candidate) -> tuple[float, int]:
        assert candidate.total_score is not None
        return (-candidate.total_score, candidate.upload_order)

    return sorted(rankable, key=ranking_key)
