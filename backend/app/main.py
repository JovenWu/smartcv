import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api import router as api_router
from backend.app.config import Settings, get_settings
from backend.app.database import SQLiteRepository
from backend.app.events import EventHub, EventPublisher
from backend.app.typesafe_adapter import create_evaluator
from backend.app.worker import CandidateWorkerPool

_LOCAL_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


def create_app(settings: Settings | None = None, evaluator=None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="SmartCV")
    app.state.settings = settings
    app.state.evaluator_override = evaluator

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
        hub = EventHub()
        publisher = EventPublisher(hub, repository)
        pool = CandidateWorkerPool(
            repository=repository,
            evaluator=active_evaluator,
            event_publisher=publisher,
            worker_count=settings.worker_count,
        )
        app.state.repository = repository
        app.state.evaluator = active_evaluator
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
            await repository.close()

    app.router.lifespan_context = lifespan
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_LOCAL_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(api_router)
    return app


app = create_app()
