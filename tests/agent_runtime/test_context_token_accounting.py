from __future__ import annotations

from types import SimpleNamespace

from web_server import (
    build_context_workspace_snapshot,
    context_transcript_stats,
    estimate_token_count,
    format_token_count,
    record_context_tool_weight_source,
    record_context_weight_source,
)


def make_assistant_record() -> dict[str, object]:
    return {
        "role": "assistant",
        "text": "Visible assistant text",
        "attachments": [{"name": "notes.md", "mime_type": "text/markdown", "kind": "file"}],
        "toolEvents": [],
        "blocks": [
            {"kind": "text", "text": "Visible assistant text"},
            {"kind": "reasoning", "text": "hidden reasoning"},
            {
                "kind": "tool",
                "tool_event": {
                    "name": "internal_tool_name",
                    "display_title": "Shell",
                    "display_detail": "run rg token",
                    "output_preview": "short preview",
                    "display_result": "result preview",
                    "raw_output": "full output with many tokens",
                    "status": "completed",
                },
            },
        ],
        "providerItems": [],
    }


def test_context_weight_source_matches_context_map_visible_fields() -> None:
    record = make_assistant_record()

    source = record_context_weight_source(record)
    tool_source = record_context_tool_weight_source(record)

    assert "Visible assistant text" in source
    assert "Shell" in source
    assert "run rg token" in source
    assert "short preview" in source
    assert "result preview" in source
    assert "full output with many tokens" in source
    assert "notes.md" in source
    assert "hidden reasoning" not in source
    assert "internal_tool_name" not in source

    assert tool_source in source
    assert "Visible assistant text" not in tool_source
    assert "notes.md" not in tool_source


def test_review_stats_and_snapshot_use_context_weight_source_counts() -> None:
    record = make_assistant_record()
    expected_total = estimate_token_count(record_context_weight_source(record))
    expected_tool = estimate_token_count(record_context_tool_weight_source(record))
    session = SimpleNamespace(title="Token test", scope="chat", transcript=[record])

    stats = context_transcript_stats(session.transcript)

    assert stats["node_count"] == 1
    assert stats["token_count"] == expected_total
    assert stats["tool_token_count"] == expected_tool

    snapshot = build_context_workspace_snapshot(session)

    assert f"{format_token_count(expected_total)} tokens" in snapshot
    assert f"tool {format_token_count(expected_tool)} tokens" in snapshot
