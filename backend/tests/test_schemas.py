from backend.app.schemas import (
    Candidate,
    CandidateDecision,
    CandidateFile,
    CandidateStatus,
    CriteriaSuggestionRequest,
    EmploymentType,
    ImportDraft,
    Opening,
    OpeningCreate,
    OpeningSource,
    SourceType,
    WorkArrangement,
)


def test_opening_serializes_camel_case():
    opening = Opening(
        id="o1",
        title="Backend Engineer",
        employment_type=EmploymentType.FULL_TIME,
        work_arrangement=WorkArrangement.HYBRID,
        skills=["Python"],
        closes_at="2026-10-15",
        source=OpeningSource(type=SourceType.MANUAL),
        criteria=[],
        created_at="2026-09-29T00:00:00Z",
        candidates=2,
        pending_review=1,
    )
    data = opening.model_dump(mode="json", by_alias=True)
    assert data["employmentType"] == "full_time"
    assert data["workArrangement"] == "hybrid"
    assert data["pendingReview"] == 1
    assert data["closesAt"] == "2026-10-15"
    assert data["source"] == {
        "type": "manual",
        "url": None,
        "filename": None,
    }


def test_opening_create_parses_camel_case():
    body = OpeningCreate.model_validate(
        {
            "title": "PM",
            "employmentType": "contract",
            "skills": ["Roadmaps"],
            "closesAt": "2026-11-01",
        }
    )
    assert body.employment_type == EmploymentType.CONTRACT
    assert body.closes_at.isoformat() == "2026-11-01"


def test_import_draft_defaults():
    draft = ImportDraft(
        source=OpeningSource(type=SourceType.LINK, url="https://x"),
    )
    assert draft.warnings == []
    assert draft.criteria == []
    assert draft.skills == []


def test_criteria_suggestion_request():
    req = CriteriaSuggestionRequest.model_validate(
        {
            "title": "FE",
            "skills": ["React"],
            "existingCriteria": [{"id": "a", "name": "A"}],
        }
    )
    assert req.existing_criteria[0].id == "a"


def test_candidate_shape():
    c = Candidate(
        id="c",
        opening_id="o",
        name="Jane",
        email=None,
        file=CandidateFile(
            filename="j.pdf", url="/api/x", mime_type="application/pdf"
        ),
        status=CandidateStatus.COMPLETE,
        upload_order=0,
        uploaded_at="2026-09-29T00:00:00Z",
        evaluations=[],
        total_score=88.0,
        is_final=True,
        decision=CandidateDecision.UNDECIDED,
        retryable=False,
    )
    data = c.model_dump(mode="json", by_alias=True)
    assert data["openingId"] == "o"
    assert data["isFinal"] is True
    assert data["file"]["mimeType"] == "application/pdf"
    assert data["decision"] == "undecided"
