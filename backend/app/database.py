import asyncio
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiosqlite

from backend.app.schemas import (
    CandidateResult,
    CandidateStatus,
    Criterion,
    CriterionEvaluation,
    EvidenceSpan,
    JobSnapshot,
    MatchStatus,
)

TERMINAL_STATUSES = (
    CandidateStatus.COMPLETE,
    CandidateStatus.NEEDS_REVIEW,
    CandidateStatus.FAILED,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS criteria (
    job_id TEXT NOT NULL REFERENCES jobs(id),
    criterion_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    weight INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (job_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    preview_path TEXT,
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
    position INTEGER NOT NULL,
    PRIMARY KEY (candidate_id, span_id)
);
CREATE TABLE IF NOT EXISTS evaluations (
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    criterion_id TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    model_fraction REAL NOT NULL,
    evidence_span_id TEXT,
    manual_fraction REAL,
    review_note TEXT,
    PRIMARY KEY (candidate_id, criterion_id)
);
"""


@dataclass
class CandidateWorkItem:
    id: str
    job_id: str
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
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        assert self._db is not None, "repository is not open"
        return self._db

    async def create_job(
        self, job_id: str, title: str, criteria: list[Criterion]
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO jobs (id, title) VALUES (?, ?)", (job_id, title)
            )
            await self.db.executemany(
                "INSERT INTO criteria "
                "(job_id, criterion_id, name, description, weight, position) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (job_id, c.id, c.name, c.description, c.weight, position)
                    for position, c in enumerate(criteria)
                ],
            )
            await self.db.commit()

    async def add_candidates(
        self, job_id: str, items: Iterable[Mapping[str, Any]]
    ) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT INTO candidates "
                "(id, job_id, filename, stored_path, upload_order, status) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        item["id"],
                        job_id,
                        item["filename"],
                        str(item["stored_path"]),
                        item["upload_order"],
                        CandidateStatus.QUEUED,
                    )
                    for item in items
                ],
            )
            await self.db.commit()

    async def job_exists(self, job_id: str) -> bool:
        cursor = await self.db.execute(
            "SELECT 1 FROM jobs WHERE id = ?", (job_id,)
        )
        return await cursor.fetchone() is not None

    async def _job_criteria(self, job_id: str) -> list[Criterion]:
        cursor = await self.db.execute(
            "SELECT criterion_id, name, description, weight FROM criteria "
            "WHERE job_id = ? ORDER BY position",
            (job_id,),
        )
        return [
            Criterion(
                id=row["criterion_id"],
                name=row["name"],
                description=row["description"],
                weight=row["weight"],
            )
            for row in await cursor.fetchall()
        ]

    async def get_candidate(self, candidate_id: str) -> CandidateWorkItem | None:
        cursor = await self.db.execute(
            "SELECT id, job_id, filename, stored_path, upload_order "
            "FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return CandidateWorkItem(
            id=row["id"],
            job_id=row["job_id"],
            filename=row["filename"],
            stored_path=Path(row["stored_path"]),
            upload_order=row["upload_order"],
            criteria=await self._job_criteria(row["job_id"]),
        )

    async def list_resumable_candidates(self) -> list[CandidateWorkItem]:
        cursor = await self.db.execute(
            "SELECT id, job_id, filename, stored_path, upload_order "
            "FROM candidates WHERE status IN (?, ?, ?) ORDER BY upload_order",
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
                    job_id=row["job_id"],
                    filename=row["filename"],
                    stored_path=Path(row["stored_path"]),
                    upload_order=row["upload_order"],
                    criteria=await self._job_criteria(row["job_id"]),
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
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                "DELETE FROM evidence_spans WHERE candidate_id = ?",
                (candidate_id,),
            )
            await self.db.executemany(
                "INSERT INTO evidence_spans "
                "(candidate_id, span_id, page_number, text, position) "
                "VALUES (?, ?, ?, ?, ?)",
                [
                    (candidate_id, span.id, span.page_number, span.text, position)
                    for position, span in enumerate(spans)
                ],
            )
            await self.db.execute(
                "UPDATE candidates SET preview_path = ? WHERE id = ?",
                (str(preview_path), candidate_id),
            )
            await self.db.commit()

    async def save_candidate_result(self, result: CandidateResult) -> None:
        async with self._write_lock:
            await self.db.executemany(
                "INSERT OR REPLACE INTO evaluations "
                "(candidate_id, criterion_id, status, confidence, "
                "model_fraction, evidence_span_id, manual_fraction, "
                "review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        result.id,
                        evaluation.criterion_id,
                        evaluation.status,
                        evaluation.confidence,
                        evaluation.model_fraction,
                        evaluation.evidence_span_id,
                        evaluation.manual_fraction,
                        evaluation.review_note,
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
                    "UPDATE jobs SET is_final = 0 WHERE id = ?",
                    (work_item.job_id,),
                )
            await self.db.commit()
        return work_item

    async def _evaluations_for(
        self, candidate_id: str
    ) -> list[CriterionEvaluation]:
        cursor = await self.db.execute(
            "SELECT e.criterion_id, e.status, e.confidence, e.model_fraction, "
            "e.evidence_span_id, e.manual_fraction, e.review_note "
            "FROM evaluations e "
            "JOIN candidates c ON c.id = e.candidate_id "
            "JOIN criteria cr ON cr.job_id = c.job_id "
            "AND cr.criterion_id = e.criterion_id "
            "WHERE e.candidate_id = ? ORDER BY cr.position",
            (candidate_id,),
        )
        return [
            CriterionEvaluation(
                criterion_id=row["criterion_id"],
                status=MatchStatus(row["status"]),
                confidence=row["confidence"],
                model_fraction=row["model_fraction"],
                evidence_span_id=row["evidence_span_id"],
                manual_fraction=row["manual_fraction"],
                review_note=row["review_note"],
            )
            for row in await cursor.fetchall()
        ]

    async def get_candidate_result(
        self, candidate_id: str
    ) -> CandidateResult | None:
        cursor = await self.db.execute(
            "SELECT id, filename, upload_order, status, total_score, "
            "error_message, retryable FROM candidates WHERE id = ?",
            (candidate_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return CandidateResult(
            id=row["id"],
            filename=row["filename"],
            upload_order=row["upload_order"],
            status=CandidateStatus(row["status"]),
            evaluations=await self._evaluations_for(candidate_id),
            total_score=row["total_score"],
            error_message=row["error_message"],
            retryable=bool(row["retryable"]),
        )

    async def update_manual_evaluation(
        self,
        candidate_id: str,
        criterion_id: str,
        manual_fraction: float,
        review_note: str | None,
    ) -> CandidateResult | None:
        from backend.app.scoring import (
            calculate_total_score,
            effective_fractions,
        )

        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE evaluations SET manual_fraction = ?, review_note = ?, "
                "status = ? WHERE candidate_id = ? AND criterion_id = ?",
                (
                    manual_fraction,
                    review_note,
                    MatchStatus.REVIEWED,
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
                CandidateStatus.NEEDS_REVIEW if still_flagged
                else CandidateStatus.COMPLETE
            )
            await self.db.execute(
                "UPDATE candidates SET status = ?, total_score = ? WHERE id = ?",
                (status, total, candidate_id),
            )
            await self.db.commit()
        return await self.get_candidate_result(candidate_id)

    async def candidate_counts(self, job_id: str) -> tuple[int, int]:
        cursor = await self.db.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN status IN (?, ?, ?) THEN 1 ELSE 0 END) AS done "
            "FROM candidates WHERE job_id = ?",
            (*TERMINAL_STATUSES, job_id),
        )
        row = await cursor.fetchone()
        return int(row["done"] or 0), int(row["total"] or 0)

    async def get_candidate_spans(
        self, candidate_id: str
    ) -> list[EvidenceSpan] | None:
        if await self.get_candidate(candidate_id) is None:
            return None
        cursor = await self.db.execute(
            "SELECT span_id, page_number, text FROM evidence_spans "
            "WHERE candidate_id = ? ORDER BY position",
            (candidate_id,),
        )
        return [
            EvidenceSpan(
                id=row["span_id"],
                page_number=row["page_number"],
                text=row["text"],
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

    async def get_job_snapshot(self, job_id: str) -> JobSnapshot | None:
        cursor = await self.db.execute(
            "SELECT id, title, is_final FROM jobs WHERE id = ?", (job_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        criteria = await self._job_criteria(job_id)
        cursor = await self.db.execute(
            "SELECT id FROM candidates WHERE job_id = ? ORDER BY upload_order",
            (job_id,),
        )
        candidates = []
        for candidate_row in await cursor.fetchall():
            candidates.append(
                await self.get_candidate_result(candidate_row["id"])
            )
        completed_count, total_count = await self.candidate_counts(job_id)
        return JobSnapshot(
            id=row["id"],
            title=row["title"],
            criteria=criteria,
            candidates=candidates,
            completed_count=completed_count,
            total_count=total_count,
            is_final=bool(row["is_final"]),
        )

    async def mark_job_complete_if_terminal(self, job_id: str) -> bool:
        async with self._write_lock:
            cursor = await self.db.execute(
                "UPDATE jobs SET is_final = 1 WHERE id = ? AND is_final = 0 "
                "AND EXISTS (SELECT 1 FROM candidates WHERE job_id = ?) "
                "AND NOT EXISTS ("
                "  SELECT 1 FROM candidates WHERE job_id = ? "
                "  AND status NOT IN (?, ?, ?)"
                ")",
                (job_id, job_id, job_id, *TERMINAL_STATUSES),
            )
            await self.db.commit()
            return cursor.rowcount == 1
