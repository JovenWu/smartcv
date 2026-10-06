from datetime import date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    """Wire models serialize camelCase to match frontend/src/types.ts."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )


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


class CandidateDecision(StrEnum):
    UNDECIDED = "undecided"
    SHORTLISTED = "shortlisted"
    PASSED = "passed"


class OpeningStatus(StrEnum):
    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"
    ARCHIVED = "archived"


class EmploymentType(StrEnum):
    FULL_TIME = "full_time"
    PART_TIME = "part_time"
    CONTRACT = "contract"
    INTERNSHIP = "internship"
    CASUAL = "casual"


class WorkArrangement(StrEnum):
    REMOTE = "remote"
    HYBRID = "hybrid"
    ONSITE = "onsite"


class SourceType(StrEnum):
    MANUAL = "manual"
    LINK = "link"
    FILE = "file"


class OpeningSource(ApiModel):
    type: SourceType = SourceType.MANUAL
    url: str | None = None
    filename: str | None = None


class CriterionInput(ApiModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""


class Criterion(ApiModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    weight: int = Field(ge=1, le=5)
    required: bool = False
    suggested_weight: int | None = Field(default=None, ge=1, le=5)
    suggestion_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class Opening(ApiModel):
    id: str
    title: str = Field(min_length=1)
    department: str = ""
    location: str = ""
    description: str = ""
    employment_type: EmploymentType | None = None
    work_arrangement: WorkArrangement | None = None
    experience_level: str | None = None
    education_level: str | None = None
    skills: list[str] | None = None
    closes_at: date | None = None
    source: OpeningSource = Field(default_factory=OpeningSource)
    status: OpeningStatus = OpeningStatus.OPEN
    criteria: list[Criterion] = []
    created_at: datetime
    updated_at: datetime | None = None
    candidates: int = Field(default=0, ge=0)
    pending_review: int = Field(default=0, ge=0)
    is_final: bool = False


class OpeningCreate(ApiModel):
    title: str = Field(min_length=1)
    department: str = ""
    location: str = ""
    description: str = ""
    employment_type: EmploymentType | None = None
    work_arrangement: WorkArrangement | None = None
    experience_level: str | None = None
    education_level: str | None = None
    skills: list[str] | None = None
    closes_at: date | None = None
    source: OpeningSource = Field(default_factory=OpeningSource)
    status: OpeningStatus = OpeningStatus.OPEN
    criteria: list[Criterion] = []


class OpeningUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1)
    department: str | None = None
    location: str | None = None
    description: str | None = None
    employment_type: EmploymentType | None = None
    work_arrangement: WorkArrangement | None = None
    experience_level: str | None = None
    education_level: str | None = None
    skills: list[str] | None = None
    closes_at: date | None = None
    status: OpeningStatus | None = None
    criteria: list[Criterion] | None = None


class UserInfo(ApiModel):
    id: str
    username: str
    is_admin: bool = False
    is_active: bool = True
    created_at: datetime


class EvidenceSpan(ApiModel):
    id: str
    page_number: int = Field(ge=1)
    text: str
    bbox: dict | None = None


class EvaluationSpan(ApiModel):
    id: str
    page_number: int = Field(ge=1)
    text: str


class CriterionEvaluation(ApiModel):
    criterion_id: str
    status: MatchStatus
    confidence: float = Field(ge=0.0, le=1.0)
    model_fraction: float = Field(ge=0.0, le=1.0)
    evidence_span_ids: list[str] = []
    rationale: str | None = None
    manual_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    review_note: str | None = None
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None


class CandidateFile(ApiModel):
    filename: str
    url: str = ""
    mime_type: str = "application/pdf"
    page_count: int | None = None


class Candidate(ApiModel):
    id: str
    opening_id: str
    name: str
    email: str | None = None
    file: CandidateFile
    status: CandidateStatus
    upload_order: int = Field(ge=0)
    uploaded_at: datetime
    evaluations: list[CriterionEvaluation] = []
    total_score: float | None = None
    is_final: bool = False
    decision: CandidateDecision = CandidateDecision.UNDECIDED
    error_message: str | None = None
    retryable: bool = False


class OpeningSnapshot(ApiModel):
    opening: Opening
    candidates: list[Candidate] = []


class WeightSuggestion(ApiModel):
    criterion_id: str
    proposed_weight: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0.0, le=1.0)


class WeightSuggestionRequest(ApiModel):
    criteria: list[CriterionInput] = Field(min_length=1)


class WeightSuggestionResponse(ApiModel):
    suggestions: list[WeightSuggestion]


class BatchUploadResponse(ApiModel):
    candidates: list[Candidate]
    duplicates: list[Candidate] = Field(default_factory=list)
    total_count: int = Field(ge=0)


class ReviewUpdate(ApiModel):
    match_level: Literal["not_found", "partial", "strong"]
    review_note: str | None = None


class DecisionUpdate(ApiModel):
    decision: CandidateDecision


class ImportLinkRequest(ApiModel):
    url: str = Field(min_length=1)


class ImportCriterion(ApiModel):
    name: str = Field(min_length=1)
    description: str = ""
    weight: int = Field(default=3, ge=1, le=5)
    required: bool = False
    suggested_weight: int | None = Field(default=None, ge=1, le=5)
    suggestion_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class ImportDraft(ApiModel):
    title: str = ""
    department: str = ""
    location: str = ""
    description: str = ""
    employment_type: EmploymentType | None = None
    work_arrangement: WorkArrangement | None = None
    experience_level: str | None = None
    education_level: str | None = None
    skills: list[str] = []
    closes_at: str | None = None
    criteria: list[ImportCriterion] = []
    source: OpeningSource
    warnings: list[str] = []


class CriterionRef(ApiModel):
    id: str
    name: str


class CriteriaSuggestionRequest(ApiModel):
    title: str | None = None
    department: str | None = None
    location: str | None = None
    employment_type: EmploymentType | None = None
    work_arrangement: WorkArrangement | None = None
    experience_level: str | None = None
    education_level: str | None = None
    description: str | None = None
    skills: list[str] = []
    existing_criteria: list[CriterionRef] = []


class SuggestedCriterion(ApiModel):
    name: str
    description: str
    suggested_weight: int = Field(ge=1, le=5)
    required: bool = False
    confidence: float = Field(ge=0.0, le=1.0)


class SkillSuggestion(ApiModel):
    skill: str
    matched_criterion_id: str | None = None
    criterion: SuggestedCriterion | None = None


class CriteriaSuggestionResponse(ApiModel):
    suggestions: list[SkillSuggestion]
