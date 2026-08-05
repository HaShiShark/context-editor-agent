from __future__ import annotations

import json
from pathlib import Path

from app_agent import settings as config_module
from app_agent.settings import Settings
from web_server import build_context_workbench_agent, resolve_context_workbench_provider_id


ROOT = Path(__file__).resolve().parents[2]


def make_settings(*, context_provider_id: str = "openai") -> Settings:
    return Settings(
        model="gpt-5.4",
        default_reasoning_effort="medium",
        context_workbench_model="gemini-3-flash-preview",
        context_workbench_provider_id=context_provider_id,
        project_root=ROOT,
        max_tool_rounds=6,
        tool_settings=[],
        response_providers=[
            {
                "id": "openai",
                "name": "OpenAI",
                "provider_type": "responses",
                "enabled": True,
                "api_base_url": "https://api.openai.com/v1",
                "default_model": "gpt-5.4",
                "models": [{"id": "gpt-5.4", "label": "gpt-5.4", "group": "GPT"}],
            },
            {
                "id": "gemini",
                "name": "Gemini",
                "provider_type": "gemini",
                "enabled": True,
                "api_base_url": "https://generativelanguage.googleapis.com/v1beta",
                "api_key": "test-gemini-key",
                "default_model": "gemini-3-flash-preview",
                "models": [
                    {
                        "id": "gemini-3-flash-preview",
                        "label": "gemini-3-flash-preview",
                        "group": "Gemini",
                    }
                ],
            },
        ],
        active_provider_id="openai",
        openai_api_key="test-openai-key",
        openai_base_url="https://api.openai.com/v1",
    )


def test_context_provider_resolution_prefers_model_owner_over_stale_provider() -> None:
    settings = make_settings(context_provider_id="openai")

    assert resolve_context_workbench_provider_id(settings, "gemini-3-flash-preview") == "gemini"


def test_context_workbench_agent_uses_resolved_gemini_provider() -> None:
    settings = make_settings(context_provider_id="openai")
    provider_id = resolve_context_workbench_provider_id(settings, settings.context_workbench_model)
    agent = build_context_workbench_agent(settings, provider_id)

    assert agent.provider_id == "gemini"
    assert agent.provider_type == "gemini"
    assert agent.provider_api_key == "test-gemini-key"


def test_context_workbench_agent_does_not_include_main_assistant_prompt() -> None:
    settings = make_settings(context_provider_id="openai")
    settings.assistant_prompt = "main chat persona should not leak"
    settings.user_profile = "main chat profile should not leak"
    provider_id = resolve_context_workbench_provider_id(settings, settings.context_workbench_model)
    agent = build_context_workbench_agent(settings, provider_id)

    assert agent.instructions == ""
    assert agent.settings.assistant_prompt == ""
    assert agent.settings.user_profile == ""


def test_settings_load_repairs_context_provider_from_context_model(tmp_path, monkeypatch) -> None:
    settings_file = tmp_path / "openai_settings.json"
    monkeypatch.setattr(config_module, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config_module, "SETTINGS_FILE", settings_file)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)

    settings_file.write_text(
        json.dumps(
            {
                "model": "gpt-5.4",
                "active_provider_id": "openai",
                "context_workbench_model": "gemini-3-flash-preview",
                "context_workbench_provider_id": "openai",
                "response_providers": make_settings().response_providers,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    loaded = config_module.load_settings()

    assert loaded.context_workbench_provider_id == "gemini"

