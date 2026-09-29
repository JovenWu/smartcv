"""Listing import agent: fetch/parse a job ad source and draft an Opening.

Pipeline (LangGraph): gather source text/binary -> optional Tavily search when
the fetch is thin or blocked -> OpenRouter (openai/gpt-6-luna) structured
extraction -> Jev weight suggestions. Produces a reviewer-editable
``ImportDraft``; nothing is persisted until the reviewer saves the opening.
"""

import base64
import html
import ipaddress
import json
import logging
import mimetypes
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
from langgraph.graph import END, START, StateGraph

from backend.app.config import Settings
from backend.app.schemas import (
    CriterionInput,
    EmploymentType,
    ImportCriterion,
    ImportDraft,
    OpeningSource,
    SourceType,
    WorkArrangement,
)

log = logging.getLogger(__name__)

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "SmartCV/1.0 (+https://localhost)"
)

_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_RE = re.compile(
    r"<(script|style|noscript|head)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_WS_RE = re.compile(r"\s+")

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

# Link fetches are capped and never touch private/loopback hosts — the URL
# comes from user input and its content is returned to the caller.
_MAX_FETCH_BYTES = 2 * 1024 * 1024
_MAX_REDIRECTS = 5

# OpenAI strict mode (used by the gpt-6-luna provider) requires `required`
# to list every property; optional fields stay nullable instead.
OPENING_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "title",
        "department",
        "location",
        "description",
        "employmentType",
        "workArrangement",
        "experienceLevel",
        "educationLevel",
        "closesAt",
        "skills",
        "criteria",
    ],
    "properties": {
        "title": {"type": "string"},
        "department": {"type": ["string", "null"]},
        "location": {"type": ["string", "null"]},
        "description": {"type": ["string", "null"]},
        "employmentType": {
            "type": ["string", "null"],
            "enum": [e.value for e in EmploymentType] + [None],
        },
        "workArrangement": {
            "type": ["string", "null"],
            "enum": [e.value for e in WorkArrangement] + [None],
        },
        "experienceLevel": {"type": ["string", "null"]},
        "educationLevel": {"type": ["string", "null"]},
        "closesAt": {
            "type": ["string", "null"],
            "description": "ISO 8601 date (YYYY-MM-DD) or null",
        },
        "skills": {
            "type": "array",
            "items": {"type": "string"},
        },
        "criteria": {
            "type": "array",
            "description": (
                "3-8 screening criteria a CV reviewer should verify."
            ),
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "description", "required"],
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "required": {"type": "boolean"},
                },
            },
        },
    },
}

_EXTRACTION_PROMPT = (
    "You extract structured data from a job advertisement for a recruiting "
    "screening tool. Read the listing text or attached document and return "
    "one JSON object matching the schema. Rules: copy enum values verbatim; "
    "use null for fields you cannot determine; closesAt must be an ISO date "
    "or null; skills is a flat list of skill names; criteria are the 3-8 "
    "concrete, checkable requirements a CV screener should verify against "
    "the listing (name, one-sentence description, required flag). "
    "Title is the role title. Never invent requirements not implied by the "
    "listing. If the provided text or file does not describe one specific "
    "job opening — for example a category page, a list of search results, "
    "a homepage, or unrelated content — return the object with title set "
    "to an empty string."
)


class ImporterUnavailable(Exception):
    """Import is not configured (missing keys); mapped to HTTP 503."""


class ListingNotReadable(Exception):
    """The source could not be fetched or parsed; mapped to HTTP 422."""


class ImportProviderError(Exception):
    """An upstream provider failed; mapped to HTTP 502."""


@dataclass
class ImportSource:
    kind: Literal["link", "file"]
    url: str | None = None
    path: Path | None = None
    filename: str | None = None
    mime_type: str | None = None

    @classmethod
    def link(cls, url: str) -> "ImportSource":
        return cls(kind="link", url=url)

    @classmethod
    def file(
        cls, path: Path | str, filename: str, mime_type: str
    ) -> "ImportSource":
        return cls(
            kind="file",
            path=Path(path),
            filename=filename,
            mime_type=mime_type,
        )

    @property
    def label(self) -> str:
        return self.url or self.filename or "listing"

    def opening_source(self) -> OpeningSource:
        if self.kind == "link":
            return OpeningSource(type=SourceType.LINK, url=self.url)
        return OpeningSource(
            type=SourceType.FILE, filename=self.filename
        )


class ImportState(TypedDict, total=False):
    source: ImportSource
    source_text: str
    binary_parts: list[dict]
    warnings: list[str]
    draft: dict


def _html_to_text(markup: str) -> str:
    markup = _BLOCK_RE.sub(" ", markup)
    text = _TAG_RE.sub(" ", markup)
    return _WS_RE.sub(" ", html.unescape(text)).strip()


def _pdf_text(path: Path) -> str:
    import pymupdf

    parts: list[str] = []
    with pymupdf.open(path) as document:
        for page in document:
            parts.append(page.get_text())
    return "\n".join(parts).strip()


def _docx_text(path: Path) -> str:
    from docx import Document

    document = Document(path)
    return "\n".join(
        paragraph.text for paragraph in document.paragraphs
    ).strip()


def _file_part(path: Path, mime_type: str, filename: str) -> dict:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    if mime_type.startswith("image/"):
        return {
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime_type};base64,{encoded}"
            },
        }
    return {
        "type": "file",
        "file": {
            "filename": filename,
            "file_data": f"data:{mime_type};base64,{encoded}",
        },
    }


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or uuid.uuid4().hex[:8]


class LangGraphImporter:
    """Real importer: fetch/search -> gpt-6-luna extraction -> Jev weights."""

    def __init__(
        self,
        settings: Settings,
        evaluator,
        client: httpx.AsyncClient,
    ) -> None:
        if settings.openrouter_api_key is None:
            raise ImporterUnavailable(
                "Listing import requires OPENROUTER_API_KEY "
                "or SMARTCV_FAKE_IMPORTER=true"
            )
        self.settings = settings
        self.evaluator = evaluator
        self.client = client
        self.graph = self._build_graph()

    async def import_listing(self, source: ImportSource) -> ImportDraft:
        state = await self.graph.ainvoke(
            {
                "source": source,
                "source_text": "",
                "binary_parts": [],
                "warnings": [],
                "draft": None,
            }
        )
        try:
            return self._to_draft(source, state)
        except ValueError as error:
            raise ImportProviderError(
                "Listing extraction returned unreadable data"
            ) from error

    # ---------- graph nodes ----------

    def _build_graph(self):
        builder = StateGraph(ImportState)
        builder.add_node("gather", self._gather)
        builder.add_node("search", self._search)
        builder.add_node("extract", self._extract)
        builder.add_node("weights", self._weights)
        builder.add_edge(START, "gather")
        builder.add_conditional_edges(
            "gather",
            self._needs_search,
            {"search": "search", "extract": "extract"},
        )
        builder.add_edge("search", "extract")
        builder.add_edge("extract", "weights")
        builder.add_edge("weights", END)
        return builder.compile()

    async def _gather(self, state: ImportState) -> dict:
        source = state["source"]
        if source.kind == "link":
            text = await self._fetch_link(source.url)
            return {"source_text": text}
        path = source.path
        assert path is not None
        suffix = path.suffix.lower()
        mime = source.mime_type or (
            mimetypes.guess_type(source.filename or "")[0]
            or "application/octet-stream"
        )
        if suffix == ".pdf":
            try:
                text = _pdf_text(path)
            except Exception:
                text = ""
            if len(text) >= self.settings.import_min_source_chars:
                return {"source_text": text[: self.settings.import_max_chars]}
            part = _file_part(path, "application/pdf", source.filename)
            return {"source_text": text, "binary_parts": [part]}
        if suffix == ".docx":
            try:
                text = _docx_text(path)
            except Exception as error:
                raise ListingNotReadable(
                    f"Could not read '{source.filename}': {error}"
                ) from error
            if len(text) >= self.settings.import_min_source_chars:
                return {"source_text": text[: self.settings.import_max_chars]}
            part = _file_part(
                path,
                "application/vnd.openxmlformats-officedocument"
                ".wordprocessingml.document",
                source.filename,
            )
            return {"source_text": text, "binary_parts": [part]}
        if suffix in _IMAGE_SUFFIXES or mime.startswith("image/"):
            if not mime.startswith("image/"):
                mime = f"image/{suffix.lstrip('.')}"
            return {"binary_parts": [_file_part(path, mime, source.filename)]}
        raise ListingNotReadable(
            f"Unsupported listing file '{source.filename}'"
        )

    @staticmethod
    def _check_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ListingNotReadable("Only http(s) links can be imported.")
        host = (parsed.hostname or "").lower()
        if not host or "." not in host:
            raise ListingNotReadable("Link has no public host.")
        if host == "localhost" or host.endswith(
            (".localhost", ".local", ".internal", ".lan")
        ):
            raise ListingNotReadable("Link points to a local host.")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_unspecified
            or address.is_multicast
        ):
            raise ListingNotReadable("Link points to a non-public address.")

    async def _fetch_link(self, url: str) -> str:
        current = url
        body: bytes | None = None
        for _ in range(_MAX_REDIRECTS + 1):
            self._check_url(current)
            try:
                async with self.client.stream(
                    "GET",
                    current,
                    headers={"User-Agent": _BROWSER_UA},
                    timeout=self.settings.import_fetch_timeout,
                ) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            return ""
                        current = urljoin(current, location)
                        continue  # re-validated at loop top
                    if response.status_code >= 400:
                        return ""
                    content_type = response.headers.get("content-type", "")
                    if "pdf" in content_type:
                        return ""
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > _MAX_FETCH_BYTES:
                            break
                        chunks.append(chunk)
                    body = b"".join(chunks)[:_MAX_FETCH_BYTES]
            except httpx.HTTPError:
                return ""
            break
        if body is None:
            return ""
        text = body.decode("utf-8", errors="replace")
        return _html_to_text(text)[: self.settings.import_max_chars]

    def _needs_search(self, state: ImportState) -> str:
        # Web search only helps links (blocked/JS-heavy boards); file
        # uploads are read directly by the model.
        source = state["source"]
        thin = len(state["source_text"]) < self.settings.import_min_source_chars
        if (
            source.kind == "link"
            and thin
            and self.settings.tavily_api_key is not None
        ):
            return "search"
        return "extract"

    @staticmethod
    def _search_query(url: str) -> str:
        """Readable query from link parts: host + slug words + job id."""
        parsed = urlparse(url)
        slug = re.sub(
            r"[^a-z0-9]+", " ", (parsed.path or "").lower()
        ).strip()
        params = parse_qs(parsed.query)
        job_id = (params.get("jobId") or params.get("id") or [""])[0]
        return " ".join(
            part
            for part in [parsed.hostname or "", slug, job_id, "job posting"]
            if part
        )

    async def _tavily_extract(self, url: str, api_key: str) -> str:
        """Server-side fetch of the exact URL (renders JS, bypasses some
        bot protection that blocks our direct fetch)."""
        try:
            response = await self.client.post(
                "https://api.tavily.com/extract",
                json={"api_key": api_key, "urls": [url]},
                timeout=self.settings.import_fetch_timeout,
            )
            response.raise_for_status()
            results = response.json().get("results", [])
        except (httpx.HTTPError, ValueError) as error:
            log.warning("Tavily extract failed: %r", error)
            return ""
        return "\n\n".join(
            raw for raw in (r.get("raw_content") or "" for r in results)
            if raw
        ).strip()

    async def _tavily_search(self, url: str, api_key: str) -> list[str]:
        try:
            response = await self.client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": api_key,
                    "query": self._search_query(url),
                    "max_results": 5,
                    "search_depth": "advanced",
                },
                timeout=self.settings.import_fetch_timeout,
            )
            response.raise_for_status()
            results = response.json().get("results", [])
        except (httpx.HTTPError, ValueError) as error:
            log.warning("Tavily search failed: %r", error)
            return []
        return [r["content"] for r in results if r.get("content")]

    async def _search(self, state: ImportState) -> dict:
        source = state["source"]
        warnings = list(state["warnings"])
        api_key = self.settings.tavily_api_key.get_secret_value()
        parts = [state["source_text"]]

        extracted = await self._tavily_extract(source.url or "", api_key)
        if extracted:
            parts.append(extracted)
            warnings.append(
                "Direct fetch was blocked; read via web extraction."
            )
        else:
            snippets = await self._tavily_search(source.url or "", api_key)
            if snippets:
                parts.extend(snippets)
                warnings.append(
                    "Fetched page was thin or blocked; "
                    "filled from web search results."
                )
            else:
                warnings.append("Web search fallback failed.")
        combined = "\n\n".join(t for t in parts if t).strip()[
            : self.settings.import_max_chars
        ]
        return {"source_text": combined, "warnings": warnings}

    async def _extract(self, state: ImportState) -> dict:
        source_text = state["source_text"].strip()
        binary_parts = state["binary_parts"]
        if not source_text and not binary_parts:
            raise ListingNotReadable(
                "Could not read the listing from that source."
            )
        text = source_text or "Extract the job ad from the attached file."
        messages = [
            {"role": "system", "content": _EXTRACTION_PROMPT},
            {
                "role": "user",
                "content": [{"type": "text", "text": text}] + binary_parts,
            },
        ]
        try:
            response = await self.client.post(
                f"{self.settings.openrouter_base_url}/chat/completions",
                headers={
                    "Authorization": (
                        "Bearer "
                        + self.settings.openrouter_api_key.get_secret_value()
                    ),
                },
                json={
                    "model": self.settings.openrouter_model,
                    "messages": messages,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "opening_draft",
                            "strict": True,
                            "schema": OPENING_DRAFT_SCHEMA,
                        },
                    },
                    "max_tokens": 4000,
                },
                timeout=self.settings.import_llm_timeout,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            draft = json.loads(content)
        except httpx.HTTPError as error:
            raise ImportProviderError(
                f"Listing extraction failed ({type(error).__name__})"
            ) from error
        except (KeyError, IndexError, ValueError) as error:
            raise ImportProviderError(
                "Listing extraction returned unreadable data"
            ) from error
        if not str(draft.get("title") or "").strip():
            # The source wasn't one specific job ad (blocked page, search
            # junk, category listing). Fail honestly rather than save a
            # fabricated opening.
            raise ListingNotReadable(
                "Could not find a specific job listing at that source "
                "(the site may block automated access). Try dropping a "
                "PDF or screenshot of the ad instead."
            )
        return {"draft": draft}

    async def _weights(self, state: ImportState) -> dict:
        draft = state["draft"]
        criteria = draft.get("criteria") or []
        warnings = list(state["warnings"])
        if not criteria:
            return {"draft": draft, "warnings": warnings}
        inputs = [
            CriterionInput(
                id=_slugify(criterion.get("name") or f"criterion-{i}"),
                name=criterion.get("name", ""),
                description=criterion.get("description") or "",
            )
            for i, criterion in enumerate(criteria)
        ]
        try:
            suggestions = await self.evaluator.suggest_weights(inputs)
        except Exception:
            warnings.append(
                "Weight suggestions unavailable; defaulting to 3."
            )
            suggestions = []
        by_id = {s.criterion_id: s for s in suggestions}
        weighted = []
        for criterion, criterion_input in zip(criteria, inputs):
            suggestion = by_id.get(criterion_input.id)
            weighted.append(
                {
                    "name": criterion_input.name,
                    "description": criterion_input.description,
                    "required": bool(criterion.get("required")),
                    "weight": (
                        suggestion.proposed_weight if suggestion else 3
                    ),
                    "suggestedWeight": (
                        suggestion.proposed_weight if suggestion else 3
                    ),
                    "suggestionConfidence": (
                        suggestion.confidence if suggestion else None
                    ),
                }
            )
        draft["criteria"] = weighted
        return {"draft": draft, "warnings": warnings}

    def _to_draft(
        self, source: ImportSource, state: ImportState
    ) -> ImportDraft:
        draft = state.get("draft") or {}
        criteria = [
            ImportCriterion(
                name=criterion.get("name", ""),
                description=criterion.get("description") or "",
                required=bool(criterion.get("required")),
                weight=criterion.get("weight") or 3,
                suggested_weight=criterion.get("suggestedWeight"),
                suggestion_confidence=criterion.get("suggestionConfidence"),
            )
            for criterion in draft.get("criteria") or []
            if criterion.get("name")
        ]
        return ImportDraft(
            title=draft.get("title") or "",
            department=draft.get("department") or "",
            location=draft.get("location") or "",
            description=draft.get("description") or "",
            employment_type=draft.get("employmentType"),
            work_arrangement=draft.get("workArrangement"),
            experience_level=draft.get("experienceLevel"),
            education_level=draft.get("educationLevel"),
            skills=[s for s in draft.get("skills") or [] if s],
            closes_at=draft.get("closesAt"),
            criteria=criteria,
            source=source.opening_source(),
            warnings=list(state.get("warnings") or []),
        )


class FakeImporter:
    """Deterministic offline importer for explicit synthetic demos."""

    async def import_listing(self, source: ImportSource) -> ImportDraft:
        label = source.label
        title = label
        if source.kind == "link" and source.url:
            host = re.sub(r"^https?://", "", source.url).split("/")[0]
            title = f"Imported listing from {host}"
        elif source.filename:
            title = Path(source.filename).stem.replace("-", " ").title()
        return ImportDraft(
            title=title,
            description="Imported listing (offline stub).",
            skills=["Example skill"],
            criteria=[
                ImportCriterion(
                    name="Example criterion",
                    description=(
                        "Placeholder criterion from the fake importer."
                    ),
                    required=False,
                    weight=3,
                    suggested_weight=3,
                    suggestion_confidence=1.0,
                )
            ],
            source=source.opening_source(),
            warnings=["Fake importer used — no live extraction."],
        )


def create_importer(settings: Settings, evaluator):
    """Build the importer for the app lifespan.

    Returns ``(importer, client)``; client is None unless a live
    LangGraphImporter was created and must be closed by the caller.
    """
    if settings.smartcv_fake_importer:
        return FakeImporter(), None
    if settings.openrouter_api_key is None:
        return None, None
    client = httpx.AsyncClient()
    return LangGraphImporter(settings, evaluator, client), client
