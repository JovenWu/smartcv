import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api import router as api_router
from backend.app.auth import SessionStore, auth_router
from backend.app.config import Settings, get_settings
from backend.app.database import SQLiteRepository
from backend.app.events import EventHub, EventPublisher
from backend.app.importer import create_importer
from backend.app.reviewer import create_reviewer
from backend.app.typesafe_adapter import create_evaluator
from backend.app.worker import CandidateWorkerPool

_LOCAL_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def create_app(
    settings: Settings | None = None,
    evaluator=None,
    importer=None,
    reviewer=None,
) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="SmartCV")
    app.state.settings = settings
    app.state.evaluator_override = evaluator
    app.state.importer_override = importer
    app.state.reviewer_override = reviewer
    app.state.sessions = SessionStore()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.getLogger("typesafe_sdk").setLevel(logging.WARNING)
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.uploads_dir.mkdir(parents=True, exist_ok=True)
        settings.previews_dir.mkdir(parents=True, exist_ok=True)
        repository = SQLiteRepository(settings.database_path)
        await repository.open()
        if app.state.evaluator_override is not None:
            active_evaluator, client = app.state.evaluator_override, None
        else:
            active_evaluator, client = create_evaluator(settings)
        if app.state.importer_override is not None:
            active_importer, import_client = (
                app.state.importer_override,
                None,
            )
        else:
            active_importer, import_client = create_importer(
                settings, active_evaluator
            )
        if app.state.reviewer_override is not None:
            active_reviewer, review_client = (
                app.state.reviewer_override,
                None,
            )
        else:
            active_reviewer, review_client = create_reviewer(settings)
        app.state.importer = active_importer
        hub = EventHub()
        publisher = EventPublisher(hub, repository)
        pool = CandidateWorkerPool(
            repository=repository,
            evaluator=active_evaluator,
            event_publisher=publisher,
            worker_count=settings.worker_count,
            reviewer=active_reviewer,
        )
        app.state.repository = repository
        app.state.evaluator = active_evaluator
        app.state.reviewer = active_reviewer
        app.state.event_hub = hub
        app.state.event_publisher = publisher
        app.state.worker_pool = pool
        await pool.start()
        try:
            yield
        finally:
            await pool.stop()
            if client is not None:
                await client.aclose()
            if import_client is not None:
                await import_client.aclose()
            if review_client is not None:
                await review_client.aclose()
            await repository.close()

    app.router.lifespan_context = lifespan
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_LOCAL_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(api_router)
    return app


app = create_app()
