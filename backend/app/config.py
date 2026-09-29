from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
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
    max_batch_files: int = 200
    max_file_bytes: int = 10_000_000
    worker_count: int = Field(default=4, ge=1)
    review_confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    data_dir: Path = DEFAULT_DATA_DIR
    database_path: Path = DEFAULT_DATA_DIR / "smartcv.sqlite3"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def previews_dir(self) -> Path:
        return self.data_dir / "previews"


@lru_cache
def get_settings() -> Settings:
    return Settings()
