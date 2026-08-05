from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app_agent.session_agent import sanitize_text

from .serialization import sanitize_value


USAGE_FIELDS = (
    "request_count",
    "input_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "non_cached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _first_int(source: dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in source and source.get(key) is not None:
            return _non_negative_int(source.get(key))
    return 0


def empty_usage_bucket() -> dict[str, object]:
    return {
        **{field: 0 for field in USAGE_FIELDS},
        "latest_at": "",
    }


def provider_usage_bucket(raw_usage: Any) -> dict[str, object] | None:
    usage = _mapping(sanitize_value(raw_usage))
    if not usage:
        return None

    cache_read = _first_int(
        usage,
        "cache_read_input_tokens",
        "cached_input_tokens",
        "cachedContentTokenCount",
        "cached_content_token_count",
    )
    cache_write = _first_int(
        usage,
        "cache_creation_input_tokens",
        "cache_write_tokens",
    )
    input_details = _mapping(
        usage.get("input_tokens_details")
        or usage.get("prompt_tokens_details")
        or usage.get("inputTokenDetails")
    )
    output_details = _mapping(
        usage.get("output_tokens_details")
        or usage.get("completion_tokens_details")
        or usage.get("outputTokenDetails")
    )
    cache_read = cache_read or _first_int(input_details, "cached_tokens", "cachedTokens")
    reasoning_tokens = _first_int(
        usage,
        "reasoning_tokens",
        "thoughtsTokenCount",
        "thoughts_token_count",
    ) or _first_int(output_details, "reasoning_tokens", "reasoningTokens")

    raw_input_tokens = _first_int(
        usage,
        "input_tokens",
        "prompt_tokens",
        "promptTokenCount",
        "prompt_token_count",
    )
    output_tokens = _first_int(
        usage,
        "output_tokens",
        "completion_tokens",
        "candidatesTokenCount",
        "candidates_token_count",
    )

    is_anthropic_usage = any(
        key in usage for key in ("cache_read_input_tokens", "cache_creation_input_tokens")
    )
    input_tokens = (
        raw_input_tokens + cache_read + cache_write
        if is_anthropic_usage
        else raw_input_tokens
    )
    non_cached_input_tokens = (
        raw_input_tokens
        if is_anthropic_usage
        else max(0, input_tokens - cache_read)
    )
    explicit_total = _first_int(
        usage,
        "total_tokens",
        "totalTokenCount",
        "total_token_count",
    )
    total_tokens = max(explicit_total, input_tokens + output_tokens)

    if total_tokens <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return None

    return {
        "request_count": 1,
        "input_tokens": input_tokens,
        "cached_input_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "non_cached_input_tokens": non_cached_input_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "total_tokens": total_tokens,
        "latest_at": _timestamp(),
    }


def normalize_usage_bucket(raw_bucket: Any) -> dict[str, object]:
    raw = _mapping(raw_bucket)
    return {
        **{field: _non_negative_int(raw.get(field)) for field in USAGE_FIELDS},
        "latest_at": sanitize_text(raw.get("latest_at") or "").strip(),
    }


def normalize_usage_summary(raw_summary: Any, session_id: str) -> dict[str, object]:
    raw = _mapping(raw_summary)
    by_kind = {
        sanitize_text(key).strip(): normalize_usage_bucket(value)
        for key, value in _mapping(raw.get("by_kind")).items()
        if sanitize_text(key).strip()
    }
    by_model = {
        sanitize_text(key).strip(): normalize_usage_bucket(value)
        for key, value in _mapping(raw.get("by_model")).items()
        if sanitize_text(key).strip()
    }
    return {
        "session_id": sanitize_text(session_id).strip(),
        **normalize_usage_bucket(raw),
        "by_kind": by_kind,
        "by_model": by_model,
    }


def _add_bucket(target: dict[str, object], addition: dict[str, object]) -> None:
    for field in USAGE_FIELDS:
        target[field] = _non_negative_int(target.get(field)) + _non_negative_int(addition.get(field))
    latest_at = sanitize_text(addition.get("latest_at") or "").strip()
    if latest_at:
        target["latest_at"] = latest_at


def add_provider_usage(
    raw_summary: Any,
    *,
    session_id: str,
    kind: str,
    model: str,
    raw_usage: Any,
) -> dict[str, object]:
    summary = normalize_usage_summary(raw_summary, session_id)
    addition = provider_usage_bucket(raw_usage)
    if addition is None:
        return summary

    safe_kind = sanitize_text(kind).strip() or "main"
    safe_model = sanitize_text(model).strip() or "unknown"
    _add_bucket(summary, addition)

    by_kind = _mapping(summary.get("by_kind"))
    kind_bucket = normalize_usage_bucket(by_kind.get(safe_kind))
    _add_bucket(kind_bucket, addition)
    by_kind[safe_kind] = kind_bucket
    summary["by_kind"] = by_kind

    by_model = _mapping(summary.get("by_model"))
    model_bucket = normalize_usage_bucket(by_model.get(safe_model))
    _add_bucket(model_bucket, addition)
    by_model[safe_model] = model_bucket
    summary["by_model"] = by_model
    return summary


def usage_summary_payload(raw_summary: Any, session_id: str) -> dict[str, object]:
    return sanitize_value(normalize_usage_summary(raw_summary, session_id))
