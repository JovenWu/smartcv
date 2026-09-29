import asyncio
import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any

import aiosqlite

from backend.app.schemas import (
    Candidate,
    CandidateDecision,
    CandidateFile,
    CandidateStatus,
    Criterion,
    CriterionEvaluation,
    EmploymentType,
    EvidenceSpan,
    MatchStatus,
    Opening,
    OpeningCreate,
    OpeningSnapshot,
    OpeningSource,
    OpeningStatus,
    OpeningUpdate,
    SourceType,
    WorkArrangement,
)

TERMINAL_STATUSES = (
    CandidateStatus.COMPLETE,
    CandidateStatus.NEEDS_REVIEW,
    CandidateStatus.FAILED,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS openings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    employment_type TEXT,
    work_arrangement TEXT,
    experience_level TEXT,
    education_level TEXT,
    skills_json TEXT,
    closes_at TEXT,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_url TEXT,
    source_filename TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT,
    is_final INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS criteria (
    opening_id TEXT NOT NULL REFERENCES openings(id),
    criterion_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    weight INTEGER NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    suggested_weight INTEGER,
    suggestion_confidence REAL,
    position INTEGER NOT NULL,
    PRIMARY KEY (opening_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    opening_id TEXT NOT NULL REFERENCES openings(id),
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    preview_path TEXT,
    name TEXT,
    email TEXT,
    mime_type TEXT,
    page_count INTEGER,
    decision TEXT NOT NULL DEFAULT 'undecided',
    uploaded_at TEXT,
    upload_order INTEGER NOT NULL,
    status TEXT NOT NULL,
    total_score REAL,
    error_message TEXT,
    retryable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS evidence_spans (
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    span_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    text TEXT NOT NULL,
    bbox TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (candidate_id, span_id)
);
CREATE TABLE IF NOT EXISTS evaluations (
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    criterion_id TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    model_fraction REAL NOT NULL,
    evidence_span_ids TEXT,
    rationale TEXT,
    manual_fraction REAL,
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    PRIMARY KEY (candidate_id, criterion_id)
);
"""

# (name, DDL) added to legacy tables when absent.
_OPENING_COLUMNS = [
    ("department", "TEXT NOT NULL DEFAULT ''"),
    ("location", "TEXT NOT NULL DEFAULT ''"),
    ("description", "TEXT NOT NULL DEFAULT ''"),
    ("employment_type", "TEXT"),
    ("work_arrangement", "TEXT"),
    ("experience_level", "TEXT"),
    ("education_level", "TEXT"),
    ("skills_json", "TEXT"),
    ("closes_at", "TEXT"),
    ("source_type", "TEXT NOT NULL DEFAULT 'manual'"),
    ("source_url", "TEXT"),
    ("source_filename", "TEXT"),
    ("status", "TEXT NOT NULL DEFAULT 'open'"),
    ("created_at", "TEXT"),
    ("updated_at", "TEXT"),
]
_CRITERIA_COLUMNS = [
    ("required", "INTEGER NOT NULL DEFAULT 0"),
    ("suggested_weight", "INTEGER"),
    ("suggestion_confidence", "REAL"),
]
_CANDIDATE_COLUMNS = [
    ("name", "TEXT"),
    ("email", "TEXT"),
    ("mime_type", "TEXT"),
    ("page_count", "INTEGER"),
    ("decision", "TEXT NOT NULL DEFAULT 'undecided'"),
    ("uploaded_at", "TEXT"),
]
_EVALUATION_COLUMNS = [
    ("rationale", "TEXT"),
    ("reviewed_by", "TEXT"),
    ("reviewed_at", "TEXT"),
]
_SPAN_COLUMNS = [("bbox", "TEXT")]

_OPENING_UPDATE_COLUMNS = {
    "title": "title",
    "department": "department",
    "location": "location",
    "description": "description",
    "employment_type": "employment_type",
    "work_arrangement": "work_arrangement",
    "experience_level": "experience_level",
    "education_level": "education_level",
    "closes_at": "closes_at",
    "status": "status",
}

_CV_WORDS = {"cv", "resume", "curriculum", "vitae"}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _name_from_filename(filename: str) -> str:
    stem = re.sub(r"\.[^.]+$", "", filename)
    words = [
        w.capitalize()
        for w in re.split(r"[-_.\s]+", stem)
        if w and w.lower() not in _CV_WORDS
    ]
    return " ".join(words) or stem or "Candidate"


@dataclass
class CandidateWorkItem:
    id: str
    opening_id: str
    filename: str
    stored_path: Path
    upload_order: int
    criteria: list[Criterion]


class SQLiteRepository:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._db: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    async def open(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(_SCHEMA)
        await self._migrate()
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        assert self._db is not None, "repository is not open"
        return self._db

    async def _table_names(self) -> set[str]:
        cursor = await self.db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        return {row["name"] for row in await cursor.fetchall()}

    async def _columns(self, table: str) -> set[str]:
        cursor = await self.db.execute(f"PRAGMA table_info({table})")
        return {row["name"] for row in await cursor.fetchall()}

    async def _migrate(self) -> None:
        """Bring a legacy jobs-based database up to the openings schema."""
        tables = await self._table_names()
        if "jobs" in tables:
            await self.db.execute(
                "INSERT INTO openings (id, title, is_final, created_at) "
                "SELECT id, title, is_final, "
                "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM jobs"
            )
            await self.db.execute("DROP TABLE jobs")
        for table in ("criteria", "candidates"):
            columns = await self._columns(table)
            if "job_id" in columns and "opening_id" not in columns:
                await self.db.execute(
                    f"ALTER TABLE {table} RENAME COLUMN job_id TO opening_id"
                )
        for table, additions in (
            ("openings", _OPENING_COLUMNS),
            ("criteria", _CRITERIA_COLUMNS),
            ("candidates", _CANDIDATE_COLUMNS),
            ("evaluations", _EVALUATION_COLUMNS),
            ("evidence_spans", _SPAN_COLUMNS),
        ):
            if table not in await self._table_names():
                continue
            existing = await self._columns(table)
            for name, ddl in additions:
                if name not in existing:
                    await self.db.execute(
                        f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"
                    )
        eval_columns = await self._columns("evaluations")
        if (
            "evidence_span_id" in eval_columns
            and "evidence_span_ids" not in eval_columns
        ):
            await self.db.execute(
                "ALTER TABLE evaluations RENAME COLUMN evidence_span_id "
                "TO evidence_span_ids"
            )
            await self.db.execute(
                "UPDATE evaluations SET evidence_span_ids = "
                "'[\"' || evidence_span_ids || '\"]' "
                "WHERE evidence_span_ids IS NOT NULL "
                "AND substr(evidence_span_ids, 1, 1) <> '['"
            )

    # ---------- openings ----------

    async def create_opening(
        self, opening_id: str, data: OpeningCreate
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO openings ("
                "id, title, department, location, description, "
                "employment_type, work_arrangement, experience_level, "
                "education_level, skills_json, closes_at, source_type, "
                "source_url, source_filename, status, created_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    opening_id,
                    data.title,
                    data.department,
                    data.location,
                    data.description,
                    data.employment_type,
                    data.work_arrangement,
                    data.experience_level,
                    data.education_level,
                    json.dumps(data.skills) if data.skills else None,
                    data.closes_at.isoformat() if data.closes_at else None,
                    data.source.type,
                    data.source.url,
                    data.source.filename,
                    data.status,
                    _utcnow(),
                ),
            )
            await self._replace_criteria(opening_id, data.criteria)
            await self.db.commit()

    async def _replace_criteria(
        self, opening_id: str, criteria: list[Criterion]
    ) -> None:
        await self.db.execute(
            "DELETE FROM criteria WHERE opening_id = ?", (opening_id,)
        )
        await self.db.executemany(
            "INSERT INTO criteria ("
            "opening_id, criterion_id, name, description, weight, "
            "required, suggested_weight, suggestion_confidence, position"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    opening_id,
                    c.id,
                    c.name,
                    c.description,
                    c.weight,
                    int(c.required),
                    c.suggested_weight,
                    c.suggestion_confidence,
                    position,
                )
                for position, c in enumerate(criteria)
            ],
        )

    async def _opening_from_row(self, row: aiosqlite.Row) -> Opening:
        opening_id = row["id"]
        criteria = await self._opening_criteria(opening_id)
        total, pending = await self._candidate_stats(opening_id)
        skills_raw = row["skills_json"]
        return Opening(
            id=opening_id,
            title=row["title"],
            department=row["department"] or "",
            location=row["location"] or "",
            description=row["description"] or "",
            employment_type=(
                EmploymentType(row["employment_type"])
                if row["employment_type"]
                else None
            ),
            work_arrangement=(
                WorkArrangement(row["work_arrangement"])
                if row["work_arrangement"]
                else None
            ),
            experience_level=row["experience_level"],
            education_level=row["education_level"],
            skills=json.loads(skills_raw) if skills_raw else None,
            closes_at=row["closes_at"],
            source=OpeningSource(
                type=SourceType(row["source_type"] or "manual"),
                url=row["source_url"],
                filename=row["source_filename"],
            ),
            status=OpeningStatus(row["status"] or "open"),
            criteria=criteria,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            candidates=total,
            pending_review=pending,
        )

    async def _opening_criteria(self, opening_id: str) -> list[Criterion]:
        cursor = await self.db.execute(
            "SELECT criterion_id, name, description, weight, required, "
            "suggested_weight, suggestion_confidence FROM criteria "
            "WHERE opening_id = ? ORDER BY position",
            (opening_id,),
        )
        return [
            Criterion(
                id=row["criterion_id"],
                name=row["name"],
                description=row["description"],
                weight=row["weight"],
                required=bool(row["required"]),
                suggested_weight=row["suggested_weight"],
                suggestion_confidence=row["suggestion_confidence"],
            )
            for row in await cursor.fetchall()
        ]

    async def _candidate_stats(self, opening_id: str) -> tuple[int, int]:
        cursor = await self.db.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS pending "
            "FROM candidates WHERE opening_id = ?",
            (CandidateStatus.NEEDS_REVIEW, opening_id),
        )
        row = await cursor.fetchone()
        return int(row["total"] or 0), int(row["pending"] or 0)

    async def get_opening(self, opening_id: str) -> Opening | None:
        cursor = await self.db.execute(
            "SELECT * FROM openings WHERE id = ?", (opening_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return await self._opening_from_row(row)

    async def opening_exists(self, opening_id: str) -> bool:
        cursor = await self.db.execute(
            "SELECT 1 FROM openings WHERE id = ?", (opening_id,)
        )
        return await cursor.fetchone() is not None

    async def list_openings(self) -> list[Opening]:
        cursor = await self.db.execute(
            "SELECT * FROM openings ORDER BY created_at DESC, id"
        )
        return [await self._opening_from_row(row) for row in await cursor.fetchall()]

    async def update_opening(
        self, opening_id: str, patch: OpeningUpdate
    ) -> Opening | None:
        fields = patch.model_fields_set
        assignments: list[str] = []
        values: list[Any] = []
        for field, column in _OPENING_UPDATE_COLUMNS.items():
            if field not in fields:
                continue
            value = getattr(patch, field)
            if column in {"department", "location", "description"}:
                value = value or ""
            elif column == "closes_at" and value is not None:
                value = value.isoformat()
            elif isinstance(value, StrEnum):
                value = str(value)
            assignments.append(f"{column} = ?")
            values.append(value)
        if "skills" in fields:
            assignments.append("skills_json = ?")
            values.append(
                json.dumps(patch.skills) if patch.skills else None
            )
        if not assignments and "criteria" not in fields:
            return await self.get_opening(opening_id)
        async with self._write_lock:
            assignments.append("updated_at = ?")
            values.append(_utcnow())
            cursor = await self.db.execute(
                f"UPDATE openings SET {', '.join(assignments)} WHERE id = ?",
                (*values, opening_id),
            )
            if cursor.rowcount == 0:
                await self.db.commit()
                return None
            if "criteria" in fields and patch.criteria is not None:
                await self._replace_criteria(opening_id, patch.criteria)
            await self.db.execute(
                "UPDATE openings SET is_final = 0 WHERE id = ?", (opening_id,)
            )
            await self.db.commit()
        return await self.get_opening(opening_id)

    # ---------- candidates ----------

    async def add_candidates(
        self, opening_id: str, items: Iterable[Mapping[str, Any]]
    ) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT INTO candidates ("
                "id, opening_id, filename, stored_path, upload_order, "
                "status, mime_type, uploaded_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        item["id"],
                        opening_id,
                        item["filename"],
                        str(item["stored_path"]),
                        item["upload_order"],
                        CandidateStatus.QUEUED,
                        item.get("mime_type"),
                        _utcnow(),
                    )
                    for item in items
                ],
            )
            await self.db.commit()

    async def get_candidate(
        self, candidate_id: str
    ) -> CandidateWorkItem | None:
        cursor = await self.db.execute(
            "SELECT id, opening_id, filename, stored_path, upload_order "
            "FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return CandidateWorkItem(
            id=row["id"],
            opening_id=row["opening_id"],
            filename=row["filename"],
            stored_path=Path(row["stored_path"]),
            upload_order=row["upload_order"],
            criteria=await self._opening_criteria(row["opening_id"]),
        )

    async def list_resumable_candidates(self) -> list[CandidateWorkItem]:
        cursor = await self.db.execute(
            "SELECT id, opening_id, filename, stored_path, upload_order "
            "FROM candidates WHERE status IN (?, ?, ?) "
            "ORDER BY upload_order",
            (
                CandidateStatus.QUEUED,
                CandidateStatus.EXTRACTING,
                CandidateStatus.EVALUATING,
            ),
        )
        items = []
        for row in await cursor.fetchall():
            items.append(
                CandidateWorkItem(
                    id=row["id"],
                    opening_id=row["opening_id"],
                    filename=row["filename"],
                    stored_path=Path(row["stored_path"]),
                    upload_order=row["upload_order"],
                    criteria=await self._opening_criteria(row["opening_id"]),
                )
            )
        return items

    async def set_candidate_status(
        self, candidate_id: str, status: CandidateStatus
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "UPDATE candidates SET status = ? WHERE id = ?",
                (status, candidate_id),
            )
            await self.db.commit()

    async def save_source_spans(
        self,
        candidate_id: str,
        preview_path: Path,
        spans: list[EvidenceSpan],
        *,
        name: str | None = None,
        email: str | None = None,
        page_count: int | None = None,
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "DELETE FROM evidence_spans WHERE candidate_id = ?",
                (candidate_id,),
            )
            await self.db.executemany(
                "INSERT INTO evidence_spans "
                "(candidate_id, span_id, page_number, text, bbox, position) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        candidate_id,
                        span.id,
                        span.page_number,
                        span.text,
                        json.dumps(span.bbox) if span.bbox else None,
                        position,
                    )
                    for position, span in enumerate(spans)
                ],
            )
            await self.db.execute(
                "UPDATE candidates SET preview_path = ?, name = ?, "
                "email = ?, page_count = ? WHERE id = ?",
                (str(preview_path), name, email, page_count, candidate_id),
            )
            await self.db.commit()

    async def save_candidate_result(self, result: Candidate) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT OR REPLACE INTO evaluations "
                "(candidate_id, criterion_id, status, confidence, "
                "model_fraction, evidence_span_ids, rationale, "
                "manual_fraction, review_note, reviewed_by, reviewed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        result.id,
                        evaluation.criterion_id,
                        evaluation.status,
                        evaluation.confidence,
                        evaluation.model_fraction,
                        json.dumps(evaluation.evidence_span_ids),
                        evaluation.rationale,
                        evaluation.manual_fraction,
                        evaluation.review_note,
                        evaluation.reviewed_by,
                        evaluation.reviewed_at.isoformat()
                        if evaluation.reviewed_at
                        else None,
                    )
                    for evaluation in result.evaluations
                ],
            )
            await self.db.execute(
                "UPDATE candidates SET status = ?, total_score = ?, "
                "error_message = NULL, retryable = 0 WHERE id = ?",
                (result.status, result.total_score, result.id),
            )
            await self.db.commit()

    async def mark_candidate_needs_review(
        self, candidate_id: str, error_message: str
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "UPDATE candidates SET status = ?, error_message = ?, "
                "total_score = NULL WHERE id = ?",
                (CandidateStatus.NEEDS_REVIEW, error_message, candidate_id),
            )
            await self.db.commit()

    async def mark_candidate_failed(
        self, candidate_id: str, error_message: str, retryable: bool
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "UPDATE candidates SET status = ?, error_message = ?, "
                "retryable = ?, total_score = NULL WHERE id = ?",
                (
                    CandidateStatus.FAILED,
                    error_message,
                    int(retryable),
                    candidate_id,
                ),
            )
            await self.db.commit()

    async def reset_candidate_for_retry(
        self, candidate_id: str
    ) -> CandidateWorkItem | None:
        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE candidates SET status = ?, error_message = NULL "
                "WHERE id = ? AND status = ? AND retryable = 1",
                (CandidateStatus.QUEUED, candidate_id, CandidateStatus.FAILED),
            )
            if cursor.rowcount == 0:
                await self.db.commit()
                return None
            work_item = await self.get_candidate(candidate_id)
            if work_item is not None:
                await self.db.execute(
                    "UPDATE openings SET is_final = 0 WHERE id = ?",
                    (work_item.opening_id,),
                )
            await self.db.commit()
        return work_item

    async def _evaluations_for(
        self, candidate_id: str
    ) -> list[CriterionEvaluation]:
        cursor = await self.db.execute(
            "SELECT e.criterion_id, e.status, e.confidence, e.model_fraction, "
            "e.evidence_span_ids, e.rationale, e.manual_fraction, "
            "e.review_note, e.reviewed_by, e.reviewed_at "
            "FROM evaluations e "
            "JOIN candidates c ON c.id = e.candidate_id "
            "JOIN criteria cr ON cr.opening_id = c.opening_id "
            "AND cr.criterion_id = e.criterion_id "
            "WHERE e.candidate_id = ? ORDER BY cr.position",
            (candidate_id,),
        )
        evaluations = []
        for row in await cursor.fetchall():
            raw_ids = row["evidence_span_ids"]
            evaluations.append(
                CriterionEvaluation(
                    criterion_id=row["criterion_id"],
                    status=MatchStatus(row["status"]),
                    confidence=row["confidence"],
                    model_fraction=row["model_fraction"],
                    evidence_span_ids=(
                        json.loads(raw_ids) if raw_ids else []
                    ),
                    rationale=row["rationale"],
                    manual_fraction=row["manual_fraction"],
                    review_note=row["review_note"],
                    reviewed_by=row["reviewed_by"],
                    reviewed_at=row["reviewed_at"],
                )
            )
        return evaluations

    async def get_candidate_result(
        self, candidate_id: str
    ) -> Candidate | None:
        cursor = await self.db.execute(
            "SELECT id, opening_id, filename, preview_path, name, email, "
            "mime_type, page_count, decision, uploaded_at, upload_order, "
            "status, total_score, error_message, retryable "
            "FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        has_preview = bool(row["preview_path"])
        status = CandidateStatus(row["status"])
        return Candidate(
            id=row["id"],
            opening_id=row["opening_id"],
            name=row["name"] or _name_from_filename(row["filename"]),
            email=row["email"],
            file=CandidateFile(
                filename=row["filename"],
                url=(
                    f"/api/openings/{row['opening_id']}/candidates/"
                    f"{row['id']}/preview"
                    if has_preview
                    else ""
                ),
                mime_type=(
                    "application/pdf"
                    if has_preview
                    else (row["mime_type"] or "application/octet-stream")
                ),
                page_count=row["page_count"],
            ),
            status=status,
            upload_order=row["upload_order"],
            uploaded_at=row["uploaded_at"] or _utcnow(),
            evaluations=await self._evaluations_for(candidate_id),
            total_score=row["total_score"],
            is_final=status == CandidateStatus.COMPLETE,
            decision=CandidateDecision(row["decision"] or "undecided"),
            error_message=row["error_message"],
            retryable=bool(row["retryable"]),
        )

    async def list_candidates(self, opening_id: str) -> list[Candidate]:
        cursor = await self.db.execute(
            "SELECT id FROM candidates WHERE opening_id = ? "
            "ORDER BY upload_order",
            (opening_id,),
        )
        candidates = []
        for row in await cursor.fetchall():
            result = await self.get_candidate_result(row["id"])
            if result is not None:
                candidates.append(result)
        return candidates

    async def update_manual_evaluation(
        self,
        candidate_id: str,
        criterion_id: str,
        manual_fraction: float,
        review_note: str | None,
        reviewed_by: str,
    ) -> Candidate | None:
        from backend.app.scoring import (
            calculate_total_score,
            effective_fractions,
        )

        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE evaluations SET manual_fraction = ?, review_note = ?, "
                "status = ?, reviewed_by = ?, reviewed_at = ? "
                "WHERE candidate_id = ? AND criterion_id = ?",
                (
                    manual_fraction,
                    review_note,
                    MatchStatus.REVIEWED,
                    reviewed_by,
                    _utcnow(),
                    candidate_id,
                    criterion_id,
                ),
            )
            if cursor.rowcount == 0:
                return None
            work_item = await self.get_candidate(candidate_id)
            if work_item is None:
                return None
            evaluations = await self._evaluations_for(candidate_id)
            weights = {c.id: c.weight for c in work_item.criteria}
            fractions = effective_fractions(
                {e.criterion_id: e for e in evaluations}
            )
            total = calculate_total_score(weights, fractions)
            still_flagged = any(
                e.status == MatchStatus.NEEDS_REVIEW for e in evaluations
            )
            status = (
                CandidateStatus.NEEDS_REVIEW
                if still_flagged
                else CandidateStatus.COMPLETE
            )
            await self.db.execute(
                "UPDATE candidates SET status = ?, total_score = ? "
                "WHERE id = ?",
                (status, total, candidate_id),
            )
            await self.db.commit()
        return await self.get_candidate_result(candidate_id)

    async def update_decision(
        self, candidate_id: str, decision: CandidateDecision
    ) -> Candidate | None:
        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE candidates SET decision = ? WHERE id = ?",
                (decision, candidate_id),
            )
            if cursor.rowcount == 0:
                await self.db.commit()
                return None
            await self.db.commit()
        return await self.get_candidate_result(candidate_id)

    async def candidate_counts(self, opening_id: str) -> tuple[int, int]:
        cursor = await self.db.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN status IN (?, ?, ?) THEN 1 ELSE 0 END) AS done "
            "FROM candidates WHERE opening_id = ?",
            (*TERMINAL_STATUSES, opening_id),
        )
        row = await cursor.fetchone()
        return int(row["done"] or 0), int(row["total"] or 0)

    async def get_candidate_spans(
        self, candidate_id: str
    ) -> list[EvidenceSpan] | None:
        if await self.get_candidate(candidate_id) is None:
            return None
        cursor = await self.db.execute(
            "SELECT span_id, page_number, text, bbox FROM evidence_spans "
            "WHERE candidate_id = ? ORDER BY position",
            (candidate_id,),
        )
        return [
            EvidenceSpan(
                id=row["span_id"],
                page_number=row["page_number"],
                text=row["text"],
                bbox=json.loads(row["bbox"]) if row["bbox"] else None,
            )
            for row in await cursor.fetchall()
        ]

    async def get_preview_path(self, candidate_id: str) -> Path | None:
        cursor = await self.db.execute(
            "SELECT preview_path FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None or row["preview_path"] is None:
            return None
        return Path(row["preview_path"])

    async def get_opening_snapshot(
        self, opening_id: str
    ) -> OpeningSnapshot | None:
        opening = await self.get_opening(opening_id)
        if opening is None:
            return None
        candidates = await self.list_candidates(opening_id)
        return OpeningSnapshot(opening=opening, candidates=candidates)

    async def mark_opening_complete_if_terminal(
        self, opening_id: str
    ) -> bool:
        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE openings SET is_final = 1 WHERE id = ? "
                "AND is_final = 0 "
                "AND EXISTS (SELECT 1 FROM candidates WHERE opening_id = ?) "
                "AND NOT EXISTS ("
                "  SELECT 1 FROM candidates WHERE opening_id = ? "
                "  AND status NOT IN (?, ?, ?)"
                ")",
                (opening_id, opening_id, opening_id, *TERMINAL_STATUSES),
            )
            await self.db.commit()
            return cursor.rowcount == 1
