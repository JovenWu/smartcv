import asyncio
import hashlib
import json
import re
import secrets
import time
import uuid
from collections.abc import Callable, Iterable, Mapping
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
    UserInfo,
    WorkArrangement,
)

TERMINAL_STATUSES = (
    CandidateStatus.COMPLETE,
    CandidateStatus.NEEDS_REVIEW,
    CandidateStatus.FAILED,
)

_OPENINGS_DDL = """
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
"""
_CRITERIA_DDL = """
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
"""
_CANDIDATES_DDL = """
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
    retryable INTEGER NOT NULL DEFAULT 0,
    file_hash TEXT
);
"""
_EVIDENCE_SPANS_DDL = """
CREATE TABLE IF NOT EXISTS evidence_spans (
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    span_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    text TEXT NOT NULL,
    bbox TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (candidate_id, span_id)
);
"""
_EVALUATIONS_DDL = """
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
_USERS_DDL = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
"""
_SESSIONS_DDL = """
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
"""

_SCHEMA = "\n".join(
    (
        _OPENINGS_DDL,
        _CRITERIA_DDL,
        _CANDIDATES_DDL,
        _EVIDENCE_SPANS_DDL,
        _EVALUATIONS_DDL,
        _USERS_DDL,
        _SESSIONS_DDL,
    )
)

_TABLE_DDL = {
    "criteria": _CRITERIA_DDL,
    "candidates": _CANDIDATES_DDL,
}

_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_candidates_opening
    ON candidates(opening_id);
CREATE INDEX IF NOT EXISTS idx_candidates_opening_file_hash
    ON candidates(opening_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_candidates_opening_status
    ON candidates(opening_id, status);
CREATE INDEX IF NOT EXISTS idx_evidence_spans_candidate
    ON evidence_spans(candidate_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_candidate
    ON evaluations(candidate_id);
"""

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
    ("file_hash", "TEXT"),
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


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
        self._requeue: Callable[[str], None] | None = None

    def set_requeue_hook(
        self, hook: Callable[[str], None] | None
    ) -> None:
        """Register the callback that requeues candidates after a
        criteria-changing opening patch (wired to worker enqueue)."""
        self._requeue = hook

    async def open(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA foreign_keys = ON")
        await self._db.execute("PRAGMA journal_mode = WAL")
        await self._db.executescript(_SCHEMA)
        await self._migrate()
        await self._db.executescript(_INDEXES)
        await self._backfill_file_hashes()
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
        """Bring a legacy jobs-based database up to the openings schema.

        Runs inside a transaction so a mid-migration crash cannot leave a
        half-migrated database. Foreign keys are suspended around it:
        the legacy ``DROP TABLE jobs`` would otherwise trip the
        ``REFERENCES jobs(id)`` declared on criteria/candidates rows.
        (The pragma is a no-op inside a transaction, hence the toggle
        happens outside BEGIN/COMMIT.)
        """
        await self.db.execute("PRAGMA foreign_keys = OFF")
        # Keep RENAME TABLE from rewriting REFERENCES clauses in other
        # tables — children must keep pointing at `candidates`, not the
        # temporary `_legacy` name, while we rebuild them.
        await self.db.execute("PRAGMA legacy_alter_table = ON")
        await self.db.execute("BEGIN")
        try:
            tables = await self._table_names()
            if "jobs" in tables:
                cursor = await self.db.execute(
                    "SELECT id, title, is_final FROM jobs"
                )
                await self.db.executemany(
                    "INSERT INTO openings (id, title, is_final, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    [
                        (row["id"], row["title"], row["is_final"], _utcnow())
                        for row in await cursor.fetchall()
                    ],
                )
                await self.db.execute("DROP TABLE jobs")
            # SQLite cannot re-target a declared REFERENCES jobs(id) —
            # rebuild any child still pointing at the dropped/legacy
            # jobs table, otherwise foreign_keys=ON would break every
            # later INSERT into it ("no such table: main.jobs").
            for table in ("criteria", "candidates"):
                if table not in await self._table_names():
                    continue
                cursor = await self.db.execute(
                    f"PRAGMA foreign_key_list({table})"
                )
                if "jobs" in {
                    row["table"] for row in await cursor.fetchall()
                }:
                    await self._repoint_child_to_openings(table)
            for table in ("criteria", "candidates"):
                columns = await self._columns(table)
                if "job_id" in columns and "opening_id" not in columns:
                    await self.db.execute(
                        f"ALTER TABLE {table} RENAME COLUMN job_id "
                        "TO opening_id"
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
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
        finally:
            await self.db.execute("PRAGMA foreign_keys = ON")
            await self.db.execute("PRAGMA legacy_alter_table = OFF")

    async def _repoint_child_to_openings(self, table: str) -> None:
        """Rebuild a legacy child so REFERENCES jobs becomes openings.

        Called inside the migration transaction. `job_id` columns are
        mapped onto `opening_id`; every other legacy column that still
        exists in the new schema is carried over.
        """
        legacy = f"{table}_legacy"
        columns = await self._columns(table)
        await self.db.execute(f"ALTER TABLE {table} RENAME TO {legacy}")
        await self.db.execute(_TABLE_DDL[table])
        current = await self._columns(table)
        pairs = [
            ("opening_id" if column == "job_id" else column, column)
            for column in columns
            if (
                "opening_id" if column == "job_id" else column
            ) in current
        ]
        await self.db.execute(
            f"INSERT INTO {table} "
            f"({', '.join(target for target, _ in pairs)}) "
            f"SELECT {', '.join(source for _, source in pairs)} "
            f"FROM {legacy}"
        )
        await self.db.execute(f"DROP TABLE {legacy}")

    async def _backfill_file_hashes(self) -> None:
        """Hash stored files for candidates that predate file_hash."""
        if "file_hash" not in await self._columns("candidates"):
            return
        cursor = await self.db.execute(
            "SELECT id, stored_path FROM candidates WHERE file_hash IS NULL"
        )
        updates = []
        for row in await cursor.fetchall():
            try:
                digest = await asyncio.to_thread(
                    _file_digest, Path(row["stored_path"])
                )
            except OSError:
                continue
            updates.append((digest, row["id"]))
        if updates:
            await self.db.executemany(
                "UPDATE candidates SET file_hash = ? WHERE id = ?", updates
            )

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

    async def _opening_from_row(
        self,
        row: aiosqlite.Row,
        criteria: list[Criterion] | None = None,
        stats: tuple[int, int] | None = None,
    ) -> Opening:
        opening_id = row["id"]
        if criteria is None:
            criteria = await self._opening_criteria(opening_id)
        if stats is None:
            stats = await self._candidate_stats(opening_id)
        total, pending = stats
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
            is_final=bool(row["is_final"]),
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

    async def _criteria_for_openings(
        self, opening_ids: list[str]
    ) -> dict[str, list[Criterion]]:
        """All criteria for the openings in one query, grouped + ordered."""
        placeholders = ", ".join("?" for _ in opening_ids)
        cursor = await self.db.execute(
            "SELECT opening_id, criterion_id, name, description, weight, "
            "required, suggested_weight, suggestion_confidence "
            f"FROM criteria WHERE opening_id IN ({placeholders}) "
            "ORDER BY opening_id, position",
            opening_ids,
        )
        grouped: dict[str, list[Criterion]] = {}
        for row in await cursor.fetchall():
            grouped.setdefault(row["opening_id"], []).append(
                Criterion(
                    id=row["criterion_id"],
                    name=row["name"],
                    description=row["description"],
                    weight=row["weight"],
                    required=bool(row["required"]),
                    suggested_weight=row["suggested_weight"],
                    suggestion_confidence=row["suggestion_confidence"],
                )
            )
        return grouped

    async def _candidate_stats_for_openings(
        self, opening_ids: list[str]
    ) -> dict[str, tuple[int, int]]:
        """(total, pending_review) per opening in one grouped query."""
        placeholders = ", ".join("?" for _ in opening_ids)
        cursor = await self.db.execute(
            "SELECT opening_id, COUNT(*) AS total, "
            "SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS pending "
            f"FROM candidates WHERE opening_id IN ({placeholders}) "
            "GROUP BY opening_id",
            (CandidateStatus.NEEDS_REVIEW, *opening_ids),
        )
        return {
            row["opening_id"]: (
                int(row["total"] or 0),
                int(row["pending"] or 0),
            )
            for row in await cursor.fetchall()
        }

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
        rows = await cursor.fetchall()
        if not rows:
            return []
        opening_ids = [row["id"] for row in rows]
        criteria = await self._criteria_for_openings(opening_ids)
        stats = await self._candidate_stats_for_openings(opening_ids)
        return [
            await self._opening_from_row(
                row,
                criteria=criteria.get(row["id"], []),
                stats=stats.get(row["id"], (0, 0)),
            )
            for row in rows
        ]

    async def update_opening(
        self,
        opening_id: str,
        patch: OpeningUpdate,
        requeue: Callable[[str], None] | None = None,
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
        criteria_changed = "criteria" in fields and patch.criteria is not None
        requeue_ids: list[str] = []
        async with self._write_lock:
            assignments.append("updated_at = ?")
            values.append(_utcnow())
            cursor = await self.db.execute(
                f"UPDATE openings SET {', '.join(assignments)} WHERE id = ?",
                (*values, opening_id),
            )
            if cursor.rowcount:
                if criteria_changed:
                    requeue_ids = await self._apply_criteria_patch(
                        opening_id, patch.criteria
                    )
                    await self.db.execute(
                        "UPDATE openings SET is_final = 0 WHERE id = ?",
                        (opening_id,),
                    )
            await self.db.commit()
        if cursor.rowcount == 0:
            return None
        hook = requeue or self._requeue
        if hook is not None:
            for candidate_id in requeue_ids:
                hook(candidate_id)
        return await self.get_opening(opening_id)

    async def _apply_criteria_patch(
        self, opening_id: str, criteria: list[Criterion]
    ) -> list[str]:
        """Swap the criteria set under an open write transaction.

        Evaluation rows for removed criterion ids are dropped, totals
        are recomputed from the surviving evals, and candidates that now
        lack an eval for a current criterion are marked queued again —
        their ids are returned so the caller (or the registered requeue
        hook) can push them back into the worker pool.
        """
        cursor = await self.db.execute(
            "SELECT criterion_id FROM criteria WHERE opening_id = ?",
            (opening_id,),
        )
        removed = {
            row["criterion_id"] for row in await cursor.fetchall()
        } - {criterion.id for criterion in criteria}
        await self._replace_criteria(opening_id, criteria)
        if removed:
            placeholders = ", ".join("?" for _ in removed)
            await self.db.execute(
                f"DELETE FROM evaluations "
                f"WHERE criterion_id IN ({placeholders}) "
                "AND candidate_id IN "
                "(SELECT id FROM candidates WHERE opening_id = ?)",
                (*removed, opening_id),
            )
        cursor = await self.db.execute(
            "SELECT c.id FROM candidates c WHERE c.opening_id = ? "
            "AND EXISTS ("
            "  SELECT 1 FROM criteria cr WHERE cr.opening_id = c.opening_id "
            "  AND NOT EXISTS ("
            "    SELECT 1 FROM evaluations e "
            "    WHERE e.candidate_id = c.id "
            "    AND e.criterion_id = cr.criterion_id"
            "  )"
            ")",
            (opening_id,),
        )
        requeue_ids = [row["id"] for row in await cursor.fetchall()]
        if requeue_ids:
            placeholders = ", ".join("?" for _ in requeue_ids)
            await self.db.execute(
                f"UPDATE candidates SET status = ?, error_message = NULL, "
                f"retryable = 0, total_score = NULL "
                f"WHERE id IN ({placeholders})",
                (CandidateStatus.QUEUED, *requeue_ids),
            )
        from backend.app.scoring import (
            calculate_total_score,
            effective_fractions,
        )

        weights = {criterion.id: criterion.weight for criterion in criteria}
        requeued = set(requeue_ids)
        evaluations = await self._evaluations_for_opening(opening_id)
        for candidate_id, evals in evaluations.items():
            if candidate_id in requeued:
                continue
            total = calculate_total_score(
                weights,
                effective_fractions({e.criterion_id: e for e in evals}),
            )
            await self.db.execute(
                "UPDATE candidates SET total_score = ? WHERE id = ?",
                (total, candidate_id),
            )
        return requeue_ids

    async def add_candidates(
        self, opening_id: str, items: Iterable[Mapping[str, Any]]
    ) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT INTO candidates ("
                "id, opening_id, filename, stored_path, upload_order, "
                "status, mime_type, uploaded_at, file_hash"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                        item.get("file_hash"),
                    )
                    for item in items
                ],
            )
            await self.db.execute(
                "UPDATE openings SET is_final = 0 WHERE id = ?", (opening_id,)
            )
            await self.db.commit()

    async def find_candidate_by_file_hash(
        self, opening_id: str, file_hash: str
    ) -> str | None:
        cursor = await self.db.execute(
            "SELECT id FROM candidates "
            "WHERE opening_id = ? AND file_hash = ? "
            "ORDER BY upload_order LIMIT 1",
            (opening_id, file_hash),
        )
        row = await cursor.fetchone()
        return row["id"] if row else None

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

    async def save_candidate_result(
        self,
        candidate_id: str,
        evaluations: list[CriterionEvaluation],
        status: CandidateStatus,
        total_score: float | None,
    ) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT OR REPLACE INTO evaluations "
                "(candidate_id, criterion_id, status, confidence, "
                "model_fraction, evidence_span_ids, rationale, "
                "manual_fraction, review_note, reviewed_by, reviewed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        candidate_id,
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
                    for evaluation in evaluations
                ],
            )
            await self.db.execute(
                "UPDATE candidates SET status = ?, total_score = ?, "
                "error_message = NULL, retryable = 0 WHERE id = ?",
                (status, total_score, candidate_id),
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

    _EVALUATION_COLUMNS = (
        "e.criterion_id, e.status, e.confidence, e.model_fraction, "
        "e.evidence_span_ids, e.rationale, e.manual_fraction, "
        "e.review_note, e.reviewed_by, e.reviewed_at"
    )

    @staticmethod
    def _evaluation_from_row(row: aiosqlite.Row) -> CriterionEvaluation:
        raw_ids = row["evidence_span_ids"]
        return CriterionEvaluation(
            criterion_id=row["criterion_id"],
            status=MatchStatus(row["status"]),
            confidence=row["confidence"],
            model_fraction=row["model_fraction"],
            evidence_span_ids=(json.loads(raw_ids) if raw_ids else []),
            rationale=row["rationale"],
            manual_fraction=row["manual_fraction"],
            review_note=row["review_note"],
            reviewed_by=row["reviewed_by"],
            reviewed_at=row["reviewed_at"],
        )

    async def _evaluations_for(
        self, candidate_id: str
    ) -> list[CriterionEvaluation]:
        cursor = await self.db.execute(
            f"SELECT {self._EVALUATION_COLUMNS} "
            "FROM evaluations e "
            "JOIN candidates c ON c.id = e.candidate_id "
            "JOIN criteria cr ON cr.opening_id = c.opening_id "
            "AND cr.criterion_id = e.criterion_id "
            "WHERE e.candidate_id = ? ORDER BY cr.position",
            (candidate_id,),
        )
        return [
            self._evaluation_from_row(row)
            for row in await cursor.fetchall()
        ]

    async def _evaluations_for_opening(
        self, opening_id: str
    ) -> dict[str, list[CriterionEvaluation]]:
        """All evals for an opening's candidates in one grouped query."""
        cursor = await self.db.execute(
            f"SELECT e.candidate_id, {self._EVALUATION_COLUMNS} "
            "FROM evaluations e "
            "JOIN candidates c ON c.id = e.candidate_id "
            "JOIN criteria cr ON cr.opening_id = c.opening_id "
            "AND cr.criterion_id = e.criterion_id "
            "WHERE c.opening_id = ? ORDER BY e.candidate_id, cr.position",
            (opening_id,),
        )
        grouped: dict[str, list[CriterionEvaluation]] = {}
        for row in await cursor.fetchall():
            grouped.setdefault(row["candidate_id"], []).append(
                self._evaluation_from_row(row)
            )
        return grouped

    @staticmethod
    def _candidate_from_row(
        row: aiosqlite.Row, evaluations: list[CriterionEvaluation]
    ) -> Candidate:
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
            evaluations=evaluations,
            total_score=row["total_score"],
            is_final=status == CandidateStatus.COMPLETE,
            decision=CandidateDecision(row["decision"] or "undecided"),
            error_message=row["error_message"],
            retryable=bool(row["retryable"]),
        )

    _CANDIDATE_RESULT_COLUMNS = (
        "id, opening_id, filename, preview_path, name, email, "
        "mime_type, page_count, decision, uploaded_at, upload_order, "
        "status, total_score, error_message, retryable"
    )

    async def get_candidate_result(
        self, candidate_id: str
    ) -> Candidate | None:
        cursor = await self.db.execute(
            f"SELECT {self._CANDIDATE_RESULT_COLUMNS} "
            "FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return self._candidate_from_row(
            row, await self._evaluations_for(candidate_id)
        )

    async def list_candidates(self, opening_id: str) -> list[Candidate]:
        cursor = await self.db.execute(
            f"SELECT {self._CANDIDATE_RESULT_COLUMNS} "
            "FROM candidates WHERE opening_id = ? ORDER BY upload_order",
            (opening_id,),
        )
        rows = await cursor.fetchall()
        if not rows:
            return []
        evaluations = await self._evaluations_for_opening(opening_id)
        return [
            self._candidate_from_row(
                row, evaluations.get(row["id"], [])
            )
            for row in rows
        ]

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
                await self.db.commit()
                return None
            work_item = await self.get_candidate(candidate_id)
            if work_item is None:
                await self.db.commit()
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
            updated = cursor.rowcount > 0
            await self.db.commit()
        if not updated:
            return None
        return await self.get_candidate_result(candidate_id)

    async def bulk_set_decision(
        self, opening_id: str, candidate_ids: list[str], decision: str
    ) -> int:
        """Set decision for the listed candidates of one opening.

        Unknown ids (or ids belonging to another opening) are skipped.
        Returns the number of rows updated.
        """
        if not candidate_ids:
            return 0
        placeholders = ", ".join("?" for _ in candidate_ids)
        async with self._write_lock:
            cursor = await self.db.execute(
                f"UPDATE candidates SET decision = ? "
                f"WHERE opening_id = ? AND id IN ({placeholders})",
                (str(decision), opening_id, *candidate_ids),
            )
            updated = cursor.rowcount
            await self.db.commit()
        return updated

    async def delete_candidate(self, candidate_id: str) -> tuple[str, ...] | None:
        """Delete evaluations, evidence_spans and the candidate row.

        Returns (stored_path, preview_path, opening_id) so callers can
        unlink files and republish progress, or None if missing.
        """
        async with self._write_lock:
            cursor = await self.db.execute(
                "SELECT stored_path, preview_path, opening_id "
                "FROM candidates WHERE id = ?",
                (candidate_id,),
            )
            row = await cursor.fetchone()
            if row is None:
                return None
            paths = (
                row["stored_path"],
                row["preview_path"],
                row["opening_id"],
            )
            await self.db.execute(
                "DELETE FROM evaluations WHERE candidate_id = ?",
                (candidate_id,),
            )
            await self.db.execute(
                "DELETE FROM evidence_spans WHERE candidate_id = ?",
                (candidate_id,),
            )
            await self.db.execute(
                "DELETE FROM candidates WHERE id = ?", (candidate_id,)
            )
            await self.db.commit()
        return paths

    async def delete_opening(
        self, opening_id: str
    ) -> list[tuple[str, str | None]] | None:
        """Delete the opening and all child rows in one transaction.

        Returns [(stored_path, preview_path), ...] for file cleanup —
        preview_path may be None — or None if the opening is missing.
        """
        async with self._write_lock:
            cursor = await self.db.execute(
                "SELECT 1 FROM openings WHERE id = ?", (opening_id,)
            )
            if await cursor.fetchone() is None:
                return None
            cursor = await self.db.execute(
                "SELECT stored_path, preview_path FROM candidates "
                "WHERE opening_id = ?",
                (opening_id,),
            )
            paths = [
                (row["stored_path"], row["preview_path"])
                for row in await cursor.fetchall()
            ]
            await self.db.execute(
                "DELETE FROM evaluations WHERE candidate_id IN "
                "(SELECT id FROM candidates WHERE opening_id = ?)",
                (opening_id,),
            )
            await self.db.execute(
                "DELETE FROM evidence_spans WHERE candidate_id IN "
                "(SELECT id FROM candidates WHERE opening_id = ?)",
                (opening_id,),
            )
            await self.db.execute(
                "DELETE FROM candidates WHERE opening_id = ?",
                (opening_id,),
            )
            await self.db.execute(
                "DELETE FROM criteria WHERE opening_id = ?",
                (opening_id,),
            )
            await self.db.execute(
                "DELETE FROM openings WHERE id = ?", (opening_id,)
            )
            await self.db.commit()
        return paths

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

    @staticmethod
    def _user_from_row(row: aiosqlite.Row) -> UserInfo:
        return UserInfo(
            id=row["id"],
            username=row["username"],
            is_admin=bool(row["is_admin"]),
            is_active=bool(row["is_active"]),
            created_at=row["created_at"],
        )

    async def user_count(self) -> int:
        cursor = await self.db.execute(
            "SELECT COUNT(*) AS n FROM users"
        )
        return int((await cursor.fetchone())["n"])

    async def list_users(self) -> list[UserInfo]:
        cursor = await self.db.execute(
            "SELECT id, username, is_admin, is_active, created_at "
            "FROM users ORDER BY username"
        )
        return [self._user_from_row(r) for r in await cursor.fetchall()]

    async def get_user(self, user_id: str) -> UserInfo | None:
        cursor = await self.db.execute(
            "SELECT id, username, is_admin, is_active, created_at "
            "FROM users WHERE id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        return self._user_from_row(row) if row else None

    async def get_user_auth(
        self, username: str
    ) -> tuple[UserInfo, str] | None:
        """User row plus its password hash for credential checks."""
        cursor = await self.db.execute(
            "SELECT id, username, password_hash, is_admin, is_active, "
            "created_at FROM users WHERE username = ?",
            (username,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return self._user_from_row(row), row["password_hash"]

    async def create_user(
        self,
        username: str,
        password_hash: str,
        *,
        is_admin: bool = False,
    ) -> UserInfo | None:
        """Insert a user; None when the username is already taken."""
        user_id = uuid.uuid4().hex
        async with self._write_lock:
            try:
                await self.db.execute(
                    "INSERT INTO users ("
                    "id, username, password_hash, is_admin, is_active, "
                    "created_at"
                    ") VALUES (?, ?, ?, ?, 1, ?)",
                    (
                        user_id,
                        username,
                        password_hash,
                        int(is_admin),
                        _utcnow(),
                    ),
                )
            except aiosqlite.IntegrityError:
                await self.db.rollback()
                return None
            await self.db.commit()
        return await self.get_user(user_id)

    async def update_user(
        self,
        user_id: str,
        *,
        is_active: bool | None = None,
        is_admin: bool | None = None,
    ) -> UserInfo | None:
        async with self._write_lock:
            if is_active is not None:
                await self.db.execute(
                    "UPDATE users SET is_active = ? WHERE id = ?",
                    (int(is_active), user_id),
                )
            if is_admin is not None:
                await self.db.execute(
                    "UPDATE users SET is_admin = ? WHERE id = ?",
                    (int(is_admin), user_id),
                )
            await self.db.commit()
        return await self.get_user(user_id)

    async def set_user_password(
        self, user_id: str, password_hash: str
    ) -> bool:
        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (password_hash, user_id),
            )
            await self.db.commit()
            return cursor.rowcount == 1

    async def seed_accounts(
        self, accounts: dict[str, str], hash_password, verify_password
    ) -> None:
        """Upsert SMARTCV_ACCOUNTS env entries into the users table.

        New usernames are inserted; existing ones get their password
        re-synced so the env var stays authoritative for seeded users.
        The first account becomes admin when no admin exists yet —
        that guarantees at least one admin can manage the rest.
        PBKDF2 runs in a thread: it is CPU-bound and this loop sits on
        the event loop.
        """
        if not accounts:
            return
        cursor = await self.db.execute(
            "SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1"
        )
        has_admin = await cursor.fetchone() is not None
        async with self._write_lock:
            for username, password in accounts.items():
                cursor = await self.db.execute(
                    "SELECT password_hash FROM users WHERE username = ?",
                    (username,),
                )
                row = await cursor.fetchone()
                if row is None:
                    digest = await asyncio.to_thread(
                        hash_password, password
                    )
                    await self.db.execute(
                        "INSERT INTO users ("
                        "id, username, password_hash, is_admin, "
                        "is_active, created_at"
                        ") VALUES (?, ?, ?, ?, 1, ?)",
                        (
                            uuid.uuid4().hex,
                            username,
                            digest,
                            int(not has_admin),
                            _utcnow(),
                        ),
                    )
                    has_admin = True
                elif not await asyncio.to_thread(
                    verify_password, password, row["password_hash"]
                ):
                    digest = await asyncio.to_thread(
                        hash_password, password
                    )
                    await self.db.execute(
                        "UPDATE users SET password_hash = ? "
                        "WHERE username = ?",
                        (digest, username),
                    )
            await self.db.commit()

    async def create_session(
        self, user_id: str, ttl_seconds: int
    ) -> str:
        raw = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        expires_at = int(time.time()) + ttl_seconds
        await self.db.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) "
            "VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )
        await self.db.commit()
        return raw

    async def user_for_token(self, raw_token: str) -> UserInfo | None:
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        cursor = await self.db.execute(
            "SELECT u.id, u.username, u.is_admin, u.is_active, "
            "u.created_at, s.expires_at "
            "FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND u.is_active = 1",
            (token_hash,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        if int(row["expires_at"]) < int(time.time()):
            await self.db.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                (token_hash,),
            )
            await self.db.commit()
            return None
        return self._user_from_row(row)

    async def delete_session(self, raw_token: str) -> None:
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        await self.db.execute(
            "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
        )
        await self.db.commit()

    async def delete_user_sessions(self, user_id: str) -> int:
        async with self._write_lock:
            cursor = await self.db.execute(
                "DELETE FROM sessions WHERE user_id = ?", (user_id,)
            )
            await self.db.commit()
            return cursor.rowcount

    async def purge_expired_sessions(self) -> None:
        await self.db.execute(
            "DELETE FROM sessions WHERE expires_at < ?",
            (int(time.time()),),
        )
        await self.db.commit()
