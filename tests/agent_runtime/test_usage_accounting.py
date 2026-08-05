from __future__ import annotations

from web_server_modules.usage import (
    add_provider_usage,
    normalize_usage_summary,
    provider_usage_bucket,
)


def test_openai_usage_normalizes_cached_and_reasoning_tokens() -> None:
    bucket = provider_usage_bucket(
        {
            "input_tokens": 100,
            "output_tokens": 30,
            "total_tokens": 130,
            "input_tokens_details": {"cached_tokens": 40},
            "output_tokens_details": {"reasoning_tokens": 12},
        }
    )

    assert bucket is not None
    assert bucket["input_tokens"] == 100
    assert bucket["cached_input_tokens"] == 40
    assert bucket["non_cached_input_tokens"] == 60
    assert bucket["output_tokens"] == 30
    assert bucket["reasoning_tokens"] == 12
    assert bucket["total_tokens"] == 130


def test_anthropic_usage_counts_cache_read_and_write_as_input() -> None:
    bucket = provider_usage_bucket(
        {
            "input_tokens": 20,
            "cache_read_input_tokens": 50,
            "cache_creation_input_tokens": 10,
            "output_tokens": 15,
        }
    )

    assert bucket is not None
    assert bucket["input_tokens"] == 80
    assert bucket["cached_input_tokens"] == 50
    assert bucket["cache_write_tokens"] == 10
    assert bucket["non_cached_input_tokens"] == 20
    assert bucket["total_tokens"] == 95


def test_gemini_usage_and_kinds_accumulate_without_cost_guessing() -> None:
    summary = normalize_usage_summary({}, "session-1")
    summary = add_provider_usage(
        summary,
        session_id="session-1",
        kind="main",
        model="gemini-2.5-pro",
        raw_usage={
            "promptTokenCount": 70,
            "candidatesTokenCount": 20,
            "thoughtsTokenCount": 8,
            "totalTokenCount": 90,
        },
    )
    summary = add_provider_usage(
        summary,
        session_id="session-1",
        kind="context_workbench",
        model="gemini-2.5-pro",
        raw_usage={
            "promptTokenCount": 30,
            "candidatesTokenCount": 10,
            "totalTokenCount": 40,
        },
    )

    assert summary["request_count"] == 2
    assert summary["total_tokens"] == 130
    assert summary["reasoning_tokens"] == 8
    assert summary["by_kind"]["main"]["total_tokens"] == 90
    assert summary["by_kind"]["context_workbench"]["total_tokens"] == 40
    assert summary["by_model"]["gemini-2.5-pro"]["request_count"] == 2
    assert "known_cost_usd" not in summary


def test_missing_provider_usage_is_not_counted() -> None:
    summary = add_provider_usage(
        {},
        session_id="session-1",
        kind="main",
        model="unknown",
        raw_usage=None,
    )

    assert summary["request_count"] == 0
    assert summary["total_tokens"] == 0
