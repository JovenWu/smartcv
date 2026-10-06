import pytest

_ENV_VARS = [
    "SMARTCV_ACCOUNTS",
    "SMARTCV_FAKE_EVALUATOR",
    "SMARTCV_FAKE_IMPORTER",
    "TYPESAFE_API_KEY",
    "TYPESAFE_MODEL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_MODEL",
    "TAVILY_API_KEY",
    "WORKER_COUNT",
    "MAX_BATCH_FILES",
    "MAX_FILE_BYTES",
    "REVIEW_CONFIDENCE_THRESHOLD",
    "ESCALATION_ENABLED",
    "ESCALATION_MIN_CONFIDENCE",
    "ESCALATION_TIMEOUT",
    "IMPORT_BROWSER_ENABLED",
    "IMPORT_BROWSER_TIMEOUT",
]


@pytest.fixture(autouse=True)
def _scrub_runtime_env(monkeypatch):
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)
