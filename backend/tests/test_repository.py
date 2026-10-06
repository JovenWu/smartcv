import sqlite3
from datetime import datetime

import aiosqlite
import pytest

from backend.app.database import SQLiteRepository
from backend.app.schemas import (
    CandidateDecision,
    CandidateStatus,
    Criterion,
    CriterionEvaluation,
    EmploymentType,
    EvidenceSpan,
    MatchStatus,
    OpeningCreate,
    OpeningSource,
    OpeningStatus,
    OpeningUpdate,
    SourceType,
)
from backend.tests.factories import make_criteria


@pytest.fixture
async def repo(tmp_path):
    r = SQLiteRepository(tmp_path / "t.sqlite3")
    await r.open()
    yield r
    await r.close()


async def _add_candidate(
    repo,
    opening_id,
    candidate_id,
    upload_order=0,
    stored_path=None,
):
    await repo.add_candidates(
        opening_id,
        [
            {
                "id": candidate_id,
                "filename": f"{candidate_id}.pdf",
                "stored_path": stored_path or f"/uploads/{candidate_id}",
                "upload_order": upload_order,
                "mime_type": "application/pdf",
            }
        ],
    )


def _eval(
    criterion_id="python",
    status=MatchStatus.STRONG,
    fraction=1.0,
):
    return CriterionEvaluation(
        criterion_id=criterion_id,
        status=status,
        confidence=0.9,
        model_fraction=fraction,
    )


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
    assert cand.name == "A"
    assert cand.opening_id == "o1"


async def test_add_candidates_reopens_terminal_opening(repo):
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
            }
        ],
    )
    await repo.mark_candidate_failed("c1", "bad pdf", retryable=False)
    assert await repo.mark_opening_complete_if_terminal("o1") is True
    assert (await repo.get_opening("o1")).is_final is True

    await repo.add_candidates(
        "o1",
        [
            {
                "id": "c2",
                "filename": "b.pdf",
                "stored_path": "/y",
                "upload_order": 1,
                "mime_type": "application/pdf",
            }
        ],
    )
    assert (await repo.get_opening("o1")).is_final is False


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
        INSERT INTO candidates
            (id, job_id, filename, stored_path, upload_order, status)
            VALUES ('c1', 'j1', 'cv.pdf', '/x', 0, 'complete');
        INSERT INTO evidence_spans VALUES ('c1', 's1', 1, 'txt', 0);
        INSERT INTO evaluations VALUES
            ('c1', 'py', 'strong', 0.9, 1.0, NULL, NULL, NULL);
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
        cursor = await repo.db.execute(
            "SELECT created_at FROM openings WHERE id = 'j1'"
        )
        assert (await cursor.fetchone())["created_at"].endswith("+00:00")
        cursor = await repo.db.execute(
            "PRAGMA foreign_key_list(candidates)"
        )
        assert {
            row["table"] for row in await cursor.fetchall()
        } == {"openings"}
        cursor = await repo.db.execute(
            "PRAGMA foreign_key_list(criteria)"
        )
        assert {
            row["table"] for row in await cursor.fetchall()
        } == {"openings"}
        candidate = await repo.get_candidate_result("c1")
        assert candidate is not None
        assert candidate.opening_id == "j1"
        assert candidate.status == CandidateStatus.COMPLETE
        assert candidate.evaluations[0].criterion_id == "py"
        await repo.save_source_spans(
            "c1", tmp_path / "p.pdf", [EvidenceSpan(id="s2", page_number=1, text="t")]
        )
        await _add_candidate(repo, "j1", "c2")
        assert (await repo.get_candidate_result("c2")).opening_id == "j1"
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


async def test_pragmas_and_indexes_applied(repo):
    cursor = await repo.db.execute("PRAGMA foreign_keys")
    assert (await cursor.fetchone())[0] == 1
    cursor = await repo.db.execute("PRAGMA journal_mode")
    assert (await cursor.fetchone())[0] == "wal"
    expected = {
        "candidates": {
            "idx_candidates_opening",
            "idx_candidates_opening_file_hash",
            "idx_candidates_opening_status",
        },
        "evidence_spans": {"idx_evidence_spans_candidate"},
        "evaluations": {"idx_evaluations_candidate"},
    }
    for table, names in expected.items():
        cursor = await repo.db.execute(f"PRAGMA index_list({table})")
        found = {row["name"] for row in await cursor.fetchall()}
        assert names <= found


async def test_foreign_keys_are_enforced(repo):
    with pytest.raises(sqlite3.IntegrityError):
        await repo.db.execute(
            "INSERT INTO evidence_spans "
            "(candidate_id, span_id, page_number, text, position) "
            "VALUES ('ghost', 's1', 1, 'text', 0)"
        )
    await repo.db.rollback()


async def test_created_at_uses_single_utc_iso8601_format(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    cursor = await repo.db.execute(
        "SELECT created_at, updated_at FROM openings WHERE id = 'o1'"
    )
    value = (await cursor.fetchone())["created_at"]
    assert value == datetime.fromisoformat(value).isoformat()
    assert value.endswith("+00:00")


async def test_archived_status_round_trip(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    patch = OpeningUpdate.model_validate({"status": "archived"})
    updated = await repo.update_opening("o1", patch)
    assert updated is not None
    assert updated.status == OpeningStatus.ARCHIVED
    listed = {o.id: o for o in await repo.list_openings()}
    assert listed["o1"].status == OpeningStatus.ARCHIVED


async def test_delete_candidate_cascades_and_returns_paths(repo, tmp_path):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria())
    )
    stored = tmp_path / "stored-c1"
    stored.write_bytes(b"pdf")
    preview = tmp_path / "preview-c1"
    preview.write_bytes(b"pdf")
    await _add_candidate(repo, "o1", "c1", stored_path=str(stored))
    await _add_candidate(repo, "o1", "c2")
    await repo.save_source_spans(
        "c1", preview, [EvidenceSpan(id="s1", page_number=1, text="t")]
    )
    await repo.save_candidate_result(
        "c1", [_eval("python")], CandidateStatus.COMPLETE, 90.0
    )

    result = await repo.delete_candidate("c1")
    assert result == (str(stored), str(preview), "o1")
    assert await repo.get_candidate_result("c1") is None
    checks = {
        "evaluations": "candidate_id = 'c1'",
        "evidence_spans": "candidate_id = 'c1'",
        "candidates": "id = 'c1'",
    }
    for table, where in checks.items():
        cursor = await repo.db.execute(
            f"SELECT COUNT(*) AS n FROM {table} WHERE {where}"
        )
        assert (await cursor.fetchone())["n"] == 0
    assert await repo.get_candidate_result("c2") is not None
    assert await repo.delete_candidate("c1") is None


async def test_delete_opening_cascades_and_returns_paths(repo, tmp_path):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria())
    )
    await repo.create_opening(
        "o2", OpeningCreate(title="B", criteria=make_criteria())
    )
    stored1 = tmp_path / "stored-c1"
    stored1.write_bytes(b"pdf")
    preview1 = tmp_path / "preview-c1"
    preview1.write_bytes(b"pdf")
    stored2 = tmp_path / "stored-c2"
    stored2.write_bytes(b"pdf")
    await _add_candidate(repo, "o1", "c1", stored_path=str(stored1))
    await _add_candidate(repo, "o1", "c2", stored_path=str(stored2))
    await _add_candidate(repo, "o2", "c3")
    await repo.save_source_spans(
        "c1", preview1, [EvidenceSpan(id="s1", page_number=1, text="t")]
    )
    await repo.save_candidate_result(
        "c1", [_eval("python")], CandidateStatus.COMPLETE, 90.0
    )
    await repo.save_candidate_result(
        "c3", [_eval("python")], CandidateStatus.COMPLETE, 80.0
    )

    paths = await repo.delete_opening("o1")
    assert sorted(paths) == sorted(
        [(str(stored1), str(preview1)), (str(stored2), None)]
    )
    assert await repo.get_opening("o1") is None
    for table in ("candidates", "criteria"):
        cursor = await repo.db.execute(
            f"SELECT COUNT(*) AS n FROM {table} WHERE opening_id = 'o1'"
        )
        assert (await cursor.fetchone())["n"] == 0
    for table in ("evaluations", "evidence_spans"):
        cursor = await repo.db.execute(
            f"SELECT COUNT(*) AS n FROM {table} "
            "WHERE candidate_id IN ('c1', 'c2')"
        )
        assert (await cursor.fetchone())["n"] == 0
    assert await repo.get_opening("o2") is not None
    assert (await repo.get_candidate_result("c3")).total_score == 80.0
    assert await repo.delete_opening("o1") is None


async def test_bulk_set_decision_counts_and_scopes(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    await repo.create_opening("o2", OpeningCreate(title="B"))
    await _add_candidate(repo, "o1", "c1")
    await _add_candidate(repo, "o1", "c2")
    await _add_candidate(repo, "o2", "c3")

    updated = await repo.bulk_set_decision(
        "o1", ["c1", "c2", "c3", "ghost"], CandidateDecision.SHORTLISTED
    )
    assert updated == 2
    assert (
        await repo.get_candidate_result("c1")
    ).decision == CandidateDecision.SHORTLISTED
    assert (
        await repo.get_candidate_result("c2")
    ).decision == CandidateDecision.SHORTLISTED
    assert (
        await repo.get_candidate_result("c3")
    ).decision == CandidateDecision.UNDECIDED
    assert await repo.bulk_set_decision("o1", [], "passed") == 0


async def test_patch_without_criteria_keeps_is_final(repo):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria())
    )
    await _add_candidate(repo, "o1", "c1")
    await repo.save_candidate_result(
        "c1",
        [_eval("python"), _eval("production"), _eval("postgresql")],
        CandidateStatus.COMPLETE,
        100.0,
    )
    assert await repo.mark_opening_complete_if_terminal("o1") is True
    assert (await repo.get_opening("o1")).is_final is True

    patch = OpeningUpdate.model_validate({"title": "B", "status": "closed"})
    updated = await repo.update_opening("o1", patch)
    assert updated.is_final is True
    assert updated.title == "B"


async def test_criteria_patch_prunes_evals_requeues_and_unfinalizes(repo):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria())
    )
    await _add_candidate(repo, "o1", "c1")
    await _add_candidate(repo, "o1", "c2")
    await repo.save_candidate_result(
        "c1",
        [_eval("python"), _eval("production"), _eval("postgresql")],
        CandidateStatus.COMPLETE,
        100.0,
    )
    await repo.save_candidate_result(
        "c2", [_eval("python")], CandidateStatus.COMPLETE, 100.0
    )
    assert await repo.mark_opening_complete_if_terminal("o1") is True

    requeued = []
    repo.set_requeue_hook(requeued.append)
    new_criteria = [make_criteria()[0], make_criteria()[2]]
    patch = OpeningUpdate.model_validate(
        {"criteria": [c.model_dump() for c in new_criteria]}
    )
    updated = await repo.update_opening("o1", patch)

    assert updated.is_final is False
    assert [c.id for c in updated.criteria] == ["python", "postgresql"]
    assert requeued == ["c2"]
    c2 = await repo.get_candidate_result("c2")
    assert c2.status == CandidateStatus.QUEUED
    assert c2.total_score is None
    c1 = await repo.get_candidate_result("c1")
    assert c1.status == CandidateStatus.COMPLETE
    assert [e.criterion_id for e in c1.evaluations] == [
        "python",
        "postgresql",
    ]
    assert c1.total_score == 100.0
    cursor = await repo.db.execute(
        "SELECT COUNT(*) AS n FROM evaluations "
        "WHERE criterion_id = 'production'"
    )
    assert (await cursor.fetchone())["n"] == 0


async def test_update_manual_evaluation_no_row_still_commits(repo):
    result = await repo.update_manual_evaluation(
        "ghost", "python", 0.5, None, "tester"
    )
    assert result is None
    await repo.create_opening("o1", OpeningCreate(title="A"))
    assert (await repo.get_opening("o1")).title == "A"


async def test_list_openings_collects_criteria_and_stats_per_opening(repo):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria()[:1])
    )
    await repo.create_opening(
        "o2", OpeningCreate(title="B", criteria=make_criteria())
    )
    await _add_candidate(repo, "o1", "c1")
    await _add_candidate(repo, "o2", "c2")
    await _add_candidate(repo, "o2", "c3", upload_order=1)
    await repo.mark_candidate_needs_review("c3", "check")

    openings = {o.id: o for o in await repo.list_openings()}
    assert [c.id for c in openings["o1"].criteria] == ["python"]
    assert [c.id for c in openings["o2"].criteria] == [
        "python",
        "production",
        "postgresql",
    ]
    assert openings["o1"].candidates == 1
    assert openings["o1"].pending_review == 0
    assert openings["o2"].candidates == 2
    assert openings["o2"].pending_review == 1


async def test_list_candidates_collects_evaluations_per_candidate(repo):
    await repo.create_opening(
        "o1", OpeningCreate(title="A", criteria=make_criteria())
    )
    await _add_candidate(repo, "o1", "c1")
    await _add_candidate(repo, "o1", "c2", upload_order=1)
    await repo.save_candidate_result(
        "c1",
        [_eval("python"), _eval("production"), _eval("postgresql")],
        CandidateStatus.COMPLETE,
        100.0,
    )
    await repo.save_candidate_result(
        "c2",
        [_eval("python", MatchStatus.NOT_FOUND, 0.0)],
        CandidateStatus.NEEDS_REVIEW,
        10.0,
    )

    candidates = await repo.list_candidates("o1")
    assert [c.id for c in candidates] == ["c1", "c2"]
    by_id = {c.id: c for c in candidates}
    assert len(by_id["c1"].evaluations) == 3
    assert by_id["c1"].total_score == 100.0
    assert by_id["c2"].evaluations[0].status == MatchStatus.NOT_FOUND
    assert by_id["c2"].total_score == 10.0
