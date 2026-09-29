from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class MatchStatus(StrEnum):
    STRONG = "strong"
    PARTIAL = "partial"
    NOT_FOUND = "not_found"
    NEEDS_REVIEW = "needs_review"
    REVIEWED = "reviewed"


class CandidateStatus(StrEnum):
    QUEUED = "queued"
    EXTRACTING = "extracting"
    EVALUATING = "evaluating"
    COMPLETE = "complete"
    NEEDS_REVIEW = "needs_review"
    FAILED = "failed"


class CriterionInput(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""


class Criterion(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    weight: int = Field(ge=1, le=5)


class WeightSuggestion(BaseModel):
    criterion_id: str
    proposed_weight: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0.0, le=1.0)


class EvidenceSpan(BaseModel):
    id: str
    page_number: int = Field(ge=1)
    text: str


class EvaluationSpan(BaseModel):
    id: str
    page_number: int = Field(ge=1)
    text: str


class CriterionEvaluation(BaseModel):
    criterion_id: str
    status: MatchStatus
    confidence: float = Field(ge=0.0, le=1.0)
    model_fraction: float = Field(ge=0.0, le=1.0)
    evidence_span_id: str | None = None
    manual_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    review_note: str | None = None


class CandidateResult(BaseModel):
    id: str
    filename: str
    upload_order: int = Field(ge=0)
    status: CandidateStatus
    evaluations: list[CriterionEvaluation] = []
    total_score: float | None = None
    error_message: str | None = None
    retryable: bool = False


class JobSnapshot(BaseModel):
    id: str
    title: str
    criteria: list[Criterion] = []
    candidates: list[CandidateResult] = []
    completed_count: int = Field(ge=0)
    total_count: int = Field(ge=0)
    is_final: bool = False


class WeightSuggestionRequest(BaseModel):
    criteria: list[CriterionInput] = Field(min_length=1)


class WeightSuggestionResponse(BaseModel):
    suggestions: list[WeightSuggestion]


class JobCreate(BaseModel):
    title: str = Field(min_length=1)
    criteria: list[Criterion] = Field(min_length=1)


class BatchUploadResponse(BaseModel):
    candidates: list[CandidateResult]
    total_count: int = Field(ge=0)


class ReviewUpdate(BaseModel):
    match_level: Literal["not_found", "partial", "strong"]
    review_note: str | None = None
