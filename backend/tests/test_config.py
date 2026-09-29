from backend.app.config import Settings


def test_import_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.openrouter_api_key is None
    assert settings.openrouter_base_url == "https://openrouter.ai/api/v1"
    assert settings.openrouter_model == "openai/gpt-6-luna"
    assert settings.tavily_api_key is None
    assert settings.smartcv_fake_importer is False
    assert settings.import_min_source_chars == 800
    assert settings.import_max_chars == 40_000
