import json
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = BACKEND_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    typesafe_api_key: SecretStr | None = None
    typesafe_model: str = "jev"
    smartcv_fake_evaluator: bool = False
    # Listing import agent (LangGraph + OpenRouter). Optional: endpoints
    # return 503 when neither a key nor the fake importer is configured.
    openrouter_api_key: SecretStr | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "openai/gpt-6-luna"
    tavily_api_key: SecretStr | None = None
    smartcv_fake_importer: bool = False
    import_fetch_timeout: float = 15.0
    import_llm_timeout: float = 90.0
    import_max_chars: int = 40_000
    import_min_source_chars: int = 800
    # JSON map of username -> password, e.g. {"recruiter": "s3cret"}.
    # Empty disables the demo gate entirely.
    smartcv_accounts: str = ""
    max_batch_files: int = 200
    max_file_bytes: int = 10_000_000
    worker_count: int = Field(default=4, ge=1)
    review_confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    data_dir: Path = DEFAULT_DATA_DIR
    # When unset, derived from data_dir so a custom data_dir stays isolated.
    database_path: Path | None = None

    @model_validator(mode="after")
    def _default_database_path(self):
        if self.database_path is None:
            self.database_path = self.data_dir / "smartcv.sqlite3"
        return self

    @property
    def demo_accounts(self) -> dict[str, str]:
        raw = self.smartcv_accounts.strip()
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(
                "SMARTCV_ACCOUNTS must be a JSON object like "
                '{"username": "password"}'
            ) from exc
        if not isinstance(data, dict) or not all(
            isinstance(k, str) and isinstance(v, str)
            for k, v in data.items()
        ):
            raise ValueError(
                "SMARTCV_ACCOUNTS must map usernames to passwords"
            )
        return data

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def previews_dir(self) -> Path:
        return self.data_dir / "previews"


@lru_cache
def get_settings() -> Settings:
    return Settings()
