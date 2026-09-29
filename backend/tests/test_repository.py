import aiosqlite
import pytest

from backend.app.database import SQLiteRepository
from backend.app.schemas import (
    CandidateDecision,
    Criterion,
    EmploymentType,
    OpeningCreate,
    OpeningSource,
    OpeningUpdate,
    SourceType,
)


@pytest.fixture
async def repo(tmp_path):
    r = SQLiteRepository(tmp_path / "t.sqlite3")
    await r.open()
    yield r
    await r.close()


async def test_create_and_get_opening_roundtrip(repo):
    await repo.create_opening(
        "o1",
        OpeningCreate(
            title="Backend Engineer",
            department="Engineering",
            employment_type=EmploymentType.FULL_TIME,
            skills=["Python"],
            source=OpeningSource(type=SourceType.LINK, url="https://x"),
            criteria=[
                Criterion(
                    id="py",
                    name="Python",
                    description="d",
                    weight=4,
                    required=True,
                    suggested_weight=5,
                    suggestion_confidence=0.8,
                )
            ],
        ),
    )
    opening = await repo.get_opening("o1")
    assert opening is not None
    assert opening.title == "Backend Engineer"
    assert opening.department == "Engineering"
    assert opening.employment_type == EmploymentType.FULL_TIME
    assert opening.skills == ["Python"]
    assert opening.source.type == SourceType.LINK
    assert opening.source.url == "https://x"
    assert opening.criteria[0].required is True
    assert opening.criteria[0].suggested_weight == 5
    assert opening.criteria[0].suggestion_confidence == 0.8
    assert opening.candidates == 0
    assert opening.created_at is not None


async def test_list_openings_counts(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    await repo.add_candidates(
        "o1",
        [
            {
                "id": "c1",
                "filename": "a.pdf",
                "stored_path": "/x",
                "upload_order": 0,
                "mime_type": "application/pdf",
            },
            {
                "id": "c2",
                "filename": "b.pdf",
                "stored_path": "/y",
                "upload_order": 1,
                "mime_type": "application/pdf",
            },
        ],
    )
    await repo.mark_candidate_needs_review("c2", "check")
    openings = await repo.list_openings()
    assert len(openings) == 1
    assert openings[0].candidates == 2
    assert openings[0].pending_review == 1


async def test_update_opening_and_decision(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    patch = OpeningUpdate.model_validate({"title": "B", "status": "closed"})
    updated = await repo.update_opening("o1", patch)
    assert updated is not None
    assert updated.title == "B"
    assert updated.status == "closed"
    assert updated.updated_at is not None

    await repo.add_candidates(
        "o1",
        [
            {
                "id": "c1",
                "filename": "a.pdf",
                "stored_path": "/x",
                "upload_order": 0,
                "mime_type": "application/pdf",
            }
        ],
    )
    cand = await repo.update_decision("c1", CandidateDecision.SHORTLISTED)
    assert cand is not None
    assert cand.decision == CandidateDecision.SHORTLISTED
    assert cand.name == "A"  # filename stem fallback
    assert cand.opening_id == "o1"


async def test_update_opening_clears_fields_sent_as_null(repo):
    await repo.create_opening(
        "o1",
        OpeningCreate(
            title="A", location="Berlin",
            employment_type=EmploymentType.FULL_TIME,
        ),
    )
    patch = OpeningUpdate.model_validate(
        {"title": "A", "location": None, "employmentType": None}
    )
    updated = await repo.update_opening("o1", patch)
    assert updated is not None
    assert updated.location == ""
    assert updated.employment_type is None


async def test_migrates_legacy_jobs_schema(tmp_path):
    db_path = tmp_path / "legacy.sqlite3"
    db = await aiosqlite.connect(db_path)
    await db.executescript(
        """
        CREATE TABLE jobs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            is_final INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE criteria (
            job_id TEXT NOT NULL REFERENCES jobs(id),
            criterion_id TEXT NOT NULL, name TEXT NOT NULL,
            description TEXT NOT NULL, weight INTEGER NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (job_id, criterion_id)
        );
        CREATE TABLE candidates (
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
            filename TEXT NOT NULL, stored_path TEXT NOT NULL,
            preview_path TEXT, upload_order INTEGER NOT NULL,
            status TEXT NOT NULL, total_score REAL, error_message TEXT,
            retryable INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE evidence_spans (
            candidate_id TEXT NOT NULL REFERENCES candidates(id),
            span_id TEXT NOT NULL, page_number INTEGER NOT NULL,
            text TEXT NOT NULL, position INTEGER NOT NULL,
            PRIMARY KEY (candidate_id, span_id)
        );
        CREATE TABLE evaluations (
            candidate_id TEXT NOT NULL REFERENCES candidates(id),
            criterion_id TEXT NOT NULL, status TEXT NOT NULL,
            confidence REAL NOT NULL, model_fraction REAL NOT NULL,
            evidence_span_id TEXT, manual_fraction REAL, review_note TEXT,
            PRIMARY KEY (candidate_id, criterion_id)
        );
        INSERT INTO jobs (id, title) VALUES ('j1', 'Legacy Job');
        INSERT INTO criteria VALUES
            ('j1', 'py', 'Python', 'desc', 4, 0);
        """
    )
    await db.commit()
    await db.close()

    repo = SQLiteRepository(db_path)
    await repo.open()
    try:
        opening = await repo.get_opening("j1")
        assert opening is not None
        assert opening.title == "Legacy Job"
        assert opening.criteria[0].id == "py"
        assert opening.criteria[0].required is False
        cols = {
            row["name"]
            for row in await (
                await repo.db.execute("PRAGMA table_info(openings)")
            ).fetchall()
        }
        assert "employment_type" in cols
        assert "source_type" in cols
        eval_cols = {
            row["name"]
            for row in await (
                await repo.db.execute("PRAGMA table_info(evaluations)")
            ).fetchall()
        }
        assert "evidence_span_ids" in eval_cols
        assert "reviewed_by" in eval_cols
    finally:
        await repo.close()
