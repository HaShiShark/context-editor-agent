from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from app_agent.session_agent import ToolEvent
from web_server import AppState, SessionState, normalize_transcript


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"

ALLOWED_TRANSCRIPT_ROLES = {"user", "assistant"}
ALLOWED_STREAM_EVENT_TYPES = {
    "delta",
    "reset",
    "model_start",
    "model_done",
    "reasoning_start",
    "reasoning_done",
    "tool_event",
    "done",
    "error",
}
PROVIDER_PROTOCOL_ITEM_TYPES = {"function_call", "function_call_output"}
PROVIDER_RAW_EVENT_TYPES = {
    "response.output_text.delta",
    "response.output_text.done",
    "response.output_item.done",
    "response.failed",
    "message_start",
    "message_delta",
    "content_block_delta",
    "content_block_stop",
    "candidate",
}
PROVIDER_RAW_PAYLOAD_KEYS = {
    "provider_event",
    "raw_event",
    "openai_event",
    "anthropic_event",
    "gemini_event",
    "choices",
    "candidate",
    "content_block",
}


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8-sig"))


class InMemoryAppState(AppState):
    def __init__(self) -> None:
        self.settings = SimpleNamespace(project_root=ROOT)
        self.lock = threading.Lock()
        self._request_condition = threading.Condition(self.lock)
        self.projects = []
        self.chat_session_ids = []
        self.sessions = {}
        self._context_review_timer_lock = threading.Lock()
        self._context_review_timers = {}
        self._auto_review_request_ids = set()

    def _hydrate_agent_locked(self, session: SessionState) -> None:
        return None

    def _save_state_locked(self) -> None:
        return None


def make_session() -> SessionState:
    return SessionState(
        session_id="contract-session",
        title="Contract session",
        scope="chat",
        project_id=None,
        agent=SimpleNamespace(),
        transcript=[],
        context_input=[],
        context_workbench_history=[],
        context_revisions=[],
        pending_context_restore=None,
        pending_context_review=None,
        usage_summary={},
    )


def make_tool_event(raw_event: dict[str, Any]) -> ToolEvent:
    return ToolEvent(
        name=str(raw_event.get("name") or ""),
        arguments=raw_event.get("arguments") if isinstance(raw_event.get("arguments"), dict) else {},
        output_preview=str(raw_event.get("output_preview") or ""),
        raw_output=str(raw_event.get("raw_output") or ""),
        display_title=str(raw_event.get("display_title") or ""),
        display_detail=str(raw_event.get("display_detail") or ""),
        display_result=str(raw_event.get("display_result") or ""),
        status=str(raw_event.get("status") or "completed"),
    )


def assert_turn_shape(records: list[dict[str, Any]], expected_tool_count: int) -> None:
    assert len(records) == 2
    assert [record.get("role") for record in records] == ["user", "assistant"]
    assert all(record.get("role") in ALLOWED_TRANSCRIPT_ROLES for record in records)

    user_record, assistant_record = records

    assert not user_record.get("toolEvents")
    assert no_tool_blocks(user_record)
    assert no_provider_protocol_items(user_record)

    assert len(assistant_record.get("toolEvents") or []) == expected_tool_count
    assert tool_block_count(assistant_record) in {0, expected_tool_count}
    assert provider_tool_item_count(assistant_record) in {0, expected_tool_count * 2}


def no_tool_blocks(record: dict[str, Any]) -> bool:
    return all(block.get("kind") != "tool" for block in record.get("blocks") or [])


def no_provider_protocol_items(record: dict[str, Any]) -> bool:
    provider_items = record.get("providerItems") or []
    canonical_items = record.get("canonicalItems") or []
    return all(
        item.get("type") not in PROVIDER_PROTOCOL_ITEM_TYPES
        for item in [*provider_items, *canonical_items]
        if isinstance(item, dict)
    )


def tool_block_count(record: dict[str, Any]) -> int:
    return sum(1 for block in record.get("blocks") or [] if block.get("kind") == "tool")


def provider_tool_item_count(record: dict[str, Any]) -> int:
    provider_items = record.get("providerItems") or []
    canonical_items = record.get("canonicalItems") or []
    return sum(
        1
        for item in [*provider_items, *canonical_items]
        if isinstance(item, dict) and item.get("type") in PROVIDER_PROTOCOL_ITEM_TYPES
    )


def assert_no_provider_stream_leak(value: Any) -> None:
    if isinstance(value, dict):
        assert not (set(value) & PROVIDER_RAW_PAYLOAD_KEYS)
        for child in value.values():
            assert_no_provider_stream_leak(child)
        return

    if isinstance(value, list):
        for child in value:
            assert_no_provider_stream_leak(child)
        return

    if isinstance(value, str):
        assert value not in PROVIDER_RAW_EVENT_TYPES


def assert_stream_event_shape(event: dict[str, Any]) -> None:
    event_type = event.get("type")
    assert event_type in ALLOWED_STREAM_EVENT_TYPES
    assert_no_provider_stream_leak(event)

    if event_type == "delta":
        assert set(event) in ({"type", "delta"}, {"type", "kind", "delta"})
        assert isinstance(event.get("delta"), str)
        if "kind" in event:
            assert event.get("kind") in {"text", "reasoning"}
    elif event_type == "reset":
        assert set(event) == {"type"}
    elif event_type in {"model_start", "model_done", "reasoning_start", "reasoning_done"}:
        assert set(event) == {"type"}
    elif event_type == "tool_event":
        assert set(event) == {"type", "tool_event"}
        assert isinstance(event.get("tool_event"), dict)
    elif event_type == "done":
        assert isinstance(event.get("answer"), str)
    elif event_type == "error":
        assert set(event) == {"type", "error"}
        assert isinstance(event.get("error"), str)


def test_append_turn_adds_only_user_and_assistant_records_for_tool_scenarios() -> None:
    fixture = load_fixture("runtime_contract_transcripts.json")

    for turn in fixture["turns"]:
        app_state = InMemoryAppState()
        session = make_session()
        app_state.sessions[session.session_id] = session
        app_state.chat_session_ids.append(session.session_id)

        app_state.append_turn(
            session,
            user_message=turn["user_message"],
            answer=turn["answer"],
            tool_events=[make_tool_event(event) for event in turn["tool_events"]],
            assistant_blocks=turn["assistant_blocks"],
        )

        assert_turn_shape(session.transcript, expected_tool_count=len(turn["tool_events"]))


def test_append_turn_preserves_claude_thinking_provider_items() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    app_state.chat_session_ids.append(session.session_id)
    provider_items = [
        {
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "Need to inspect the file.",
                    "signature": "signed-thinking",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                },
            ],
        },
        {
            "type": "function_call_output",
            "call_id": "toolu_1",
            "output": "contents",
        },
        {
            "type": "message",
            "role": "assistant",
            "content": "done",
        },
    ]

    app_state.append_turn(
        session,
        user_message="read README",
        answer="done",
        tool_events=[],
        assistant_blocks=[{"kind": "text", "text": "done"}],
        assistant_provider_items=provider_items,
    )

    assistant_record = session.transcript[1]
    assert assistant_record["providerItems"] == provider_items
    assert normalize_transcript(session.transcript)[1]["providerItems"] == provider_items


def test_transcript_fixtures_keep_provider_protocol_inside_assistant_record() -> None:
    fixture = load_fixture("runtime_contract_transcripts.json")

    for turn in fixture["turns"]:
        product_records = [
            {
                "role": "user",
                "text": turn["user_message"],
                "toolEvents": [],
                "blocks": [{"kind": "text", "text": turn["user_message"]}],
                "providerItems": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": turn["user_message"],
                    }
                ],
            },
            {
                "role": "assistant",
                "text": turn["answer"],
                "toolEvents": turn["tool_events"],
                "blocks": turn["assistant_blocks"],
                "providerItems": build_fixture_provider_items(turn),
            },
        ]

        assert_turn_shape(product_records, expected_tool_count=len(turn["tool_events"]))


def build_fixture_provider_items(turn: dict[str, Any]) -> list[dict[str, Any]]:
    provider_items: list[dict[str, Any]] = []
    for index, event in enumerate(turn["tool_events"], start=1):
        call_id = f"fixture_{turn['id']}_{index}"
        provider_items.extend(
            [
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": event["name"],
                    "arguments": json.dumps(event["arguments"], ensure_ascii=False),
                },
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": event["raw_output"],
                },
            ]
        )

    provider_items.append(
        {
            "type": "message",
            "role": "assistant",
            "content": turn["answer"],
        }
    )
    return provider_items


def test_stream_fixtures_expose_only_product_events_to_frontend() -> None:
    fixture = load_fixture("runtime_contract_stream_events.json")

    for stream in fixture["streams"]:
        events = stream["events"]
        assert events
        assert events[-1]["type"] in {"done", "error"}
        for event in events:
            assert_stream_event_shape(event)


def test_clear_context_workbench_history_updates_active_revision_snapshot() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session

    transcript = [
        {
            "role": "user",
            "text": "请整理上下文",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "请整理上下文"}],
            "providerItems": [
                {
                    "type": "message",
                    "role": "user",
                    "content": "请整理上下文",
                }
            ],
        },
        {
            "role": "assistant",
            "text": "已整理",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "已整理"}],
            "providerItems": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": "已整理",
                }
            ],
        },
    ]
    session.context_workbench_history = [
        {"role": "user", "content": "哪里太长？"},
        {"role": "assistant", "content": "节点 #2 太长。"},
    ]

    app_state.apply_context_workbench_mutation(
        session,
        transcript=transcript,
        revision_label="压缩上下文",
        revision_summary="压缩了当前上下文。",
        operations=[{"operation_type": "compress_nodes", "node_numbers": [2]}],
    )
    app_state.append_context_workbench_turn(
        session,
        user_message="还能再删吗？",
        answer="可以删掉重复内容。",
    )

    assert len(session.context_workbench_history) == 4

    _, history, revisions, pending_restore = app_state.clear_context_workbench_history(session)

    assert history == []
    assert pending_restore is None
    assert revisions[0]["is_active"] is True
    active_revision = next(
        revision for revision in session.context_revisions if revision.get("is_active")
    )
    assert active_revision["context_workbench_history_snapshot"] == []


def test_main_chat_without_context_edits_is_revision_zero() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session

    app_state.append_turn(
        session,
        user_message="hello",
        answer="hi",
        tool_events=[],
        assistant_blocks=[{"kind": "text", "text": "hi"}],
    )

    revisions = session.context_revisions
    assert len(revisions) == 1
    assert revisions[0]["revision_number"] == 0
    assert revisions[0]["is_active"] is True
    assert revisions[0]["snapshot"] == session.transcript


def test_first_context_mutation_adds_restorable_revision_zero() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    session.transcript = [
        {
            "role": "user",
            "text": "original user text",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "original user text"}],
            "providerItems": [
                {"type": "message", "role": "user", "content": "original user text"}
            ],
        },
        {
            "role": "assistant",
            "text": "original assistant text",
            "attachments": [],
            "toolEvents": [],
            "blocks": [{"kind": "text", "text": "original assistant text"}],
            "providerItems": [
                {"type": "message", "role": "assistant", "content": "original assistant text"}
            ],
        },
    ]
    compressed_transcript = [
        {
            **session.transcript[0],
            "text": "compressed user text",
            "blocks": [{"kind": "text", "text": "compressed user text"}],
        },
        session.transcript[1],
    ]

    _, revisions, _ = app_state.apply_context_workbench_mutation(
        session,
        transcript=compressed_transcript,
        revision_label="压缩上下文",
        revision_summary="压缩了当前上下文。",
        operations=[{"operation_type": "compress_nodes", "node_numbers": [1]}],
    )

    assert [revision["revision_number"] for revision in revisions] == [1, 0]
    revision_zero = next(
        revision for revision in session.context_revisions if revision["revision_number"] == 0
    )

    conversation, history, restored_revisions, pending_restore = app_state.restore_context_revision(
        session,
        str(revision_zero["id"]),
    )

    assert [record["text"] for record in conversation] == [
        "original user text",
        "original assistant text",
    ]
    assert history == []
    assert pending_restore is not None
    assert next(
        revision for revision in restored_revisions if revision["revision_number"] == 0
    )["is_active"] is True
