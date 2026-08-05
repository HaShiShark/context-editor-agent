from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    import tiktoken
except ImportError:  # pragma: no cover - dependency fallback for partially installed environments
    tiktoken = None

from app_agent.session_agent import sanitize_text
from app_agent.tools import ToolExecution

from .attachments import normalize_attachment_records
from .serialization import sanitize_value
from .transcript import (
    block_text_preview,
    compile_record_from_provider_items,
    context_detail_block,
    extract_text_from_provider_message_content,
    extract_tool_events_from_blocks,
    normalize_message_blocks,
    normalize_provider_items,
    normalize_transcript,
    provider_item_detail,
)


_TOKEN_ENCODING: Any | None = None
_TOKEN_ENCODING_LOAD_FAILED = False


@dataclass(slots=True)
class ContextWorkbenchToolDefinition:
    name: str
    label: str
    description: str
    parameters: dict[str, Any]
    status: str
    handler: Callable[[dict[str, Any]], ToolExecution]

    def to_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }

    def to_catalog_item(self) -> dict[str, str]:
        return {
            "id": self.name,
            "label": self.label,
            "description": self.description,
            "status": self.status,
        }


def provider_items_tool_token_count(items: list[dict[str, Any]]) -> int:
    total = 0
    for item in items:
        if sanitize_text(item.get("type") or "").strip() not in {"function_call", "function_call_output"}:
            continue
        total += estimate_provider_item_token_count(item)
    return total


def normalize_selected_node_indexes(raw_indexes: Any, transcript_length: int) -> list[int]:
    if not isinstance(raw_indexes, list):
        return []

    selected_indexes: list[int] = []
    for raw_item in raw_indexes:
        try:
            index = int(raw_item)
        except (TypeError, ValueError):
            continue

        if 0 <= index < transcript_length and index not in selected_indexes:
            selected_indexes.append(index)

    return selected_indexes


def normalize_node_numbers(raw_numbers: Any, max_node_number: int) -> list[int]:
    if not isinstance(raw_numbers, list):
        return []

    normalized: list[int] = []
    for raw_item in raw_numbers:
        try:
            node_number = int(raw_item)
        except (TypeError, ValueError):
            continue

        if 1 <= node_number <= max_node_number and node_number not in normalized:
            normalized.append(node_number)

    return normalized


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_token_encoding() -> Any | None:
    global _TOKEN_ENCODING, _TOKEN_ENCODING_LOAD_FAILED

    if _TOKEN_ENCODING is not None:
        return _TOKEN_ENCODING
    if _TOKEN_ENCODING_LOAD_FAILED or tiktoken is None:
        return None

    try:
        _TOKEN_ENCODING = tiktoken.get_encoding("cl100k_base")
    except Exception:
        _TOKEN_ENCODING_LOAD_FAILED = True
        return None

    return _TOKEN_ENCODING


def estimate_token_count(text: str) -> int:
    safe_text = sanitize_text(text)
    if not safe_text.strip():
        return 0

    encoding = get_token_encoding()
    if encoding is not None:
        try:
            return len(encoding.encode(safe_text))
        except Exception:
            pass

    compact = safe_text.strip()
    ascii_tokens = re.findall(r"[A-Za-z0-9_]+", compact)
    non_ascii_chars = [char for char in compact if not char.isspace() and not char.isascii()]
    return max(1, len(ascii_tokens) + len(non_ascii_chars))


def unique_int_list(values: Any) -> list[int]:
    if not isinstance(values, list):
        return []

    unique_values: list[int] = []
    for raw_value in values:
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            continue
        if value not in unique_values:
            unique_values.append(value)
    return unique_values


def unique_text_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []

    unique_values: list[str] = []
    for raw_value in values:
        value = sanitize_text(raw_value or "").strip()
        if value and value not in unique_values:
            unique_values.append(value)
    return unique_values


def operation_changed_nodes(operation: dict[str, object]) -> list[int]:
    explicit_nodes = unique_int_list(operation.get("changed_nodes"))
    if explicit_nodes:
        return explicit_nodes

    target_nodes = unique_int_list(operation.get("target_node_numbers"))
    if target_nodes:
        return target_nodes

    target_items = operation.get("target_items")
    if isinstance(target_items, list):
        item_nodes: list[int] = []
        for item in target_items:
            if not isinstance(item, dict):
                continue
            try:
                node_number = int(item.get("node_number") or 0)
            except (TypeError, ValueError):
                continue
            if node_number > 0 and node_number not in item_nodes:
                item_nodes.append(node_number)
        if item_nodes:
            return item_nodes

    return []


def normalize_change_type(raw_value: Any) -> str:
    value = sanitize_text(raw_value or "").strip().lower()
    if value in {"delete", "replace", "compress", "mixed", "update"}:
        return value
    if value.startswith("delete"):
        return "delete"
    if value.startswith("replace"):
        return "replace"
    if value.startswith("compress"):
        return "compress"
    return "update"


def operation_change_type(operation: dict[str, object]) -> str:
    return normalize_change_type(
        operation.get("change_type")
        or operation.get("operation_type")
        or operation.get("type")
        or "update"
    )


def summarize_change_type(change_types: list[str]) -> str:
    normalized = [normalize_change_type(item) for item in change_types if sanitize_text(item).strip()]
    unique_types = [item for item in normalized if item]
    if not unique_types:
        return "update"
    if len(set(unique_types)) == 1:
        return unique_types[0]
    return "mixed"


def summarize_changed_nodes_from_operations(operations: list[dict[str, object]]) -> list[int]:
    changed_nodes: list[int] = []
    for operation in operations:
        for node_number in operation_changed_nodes(operation):
            if node_number not in changed_nodes:
                changed_nodes.append(node_number)
    return changed_nodes

def fallback_context_revision_summary(label: str, operations: list[dict[str, object]]) -> str:
    safe_label = sanitize_text(label).strip() or "上下文更新"
    if not operations:
        return safe_label

    if len(operations) > 1:
        changed_nodes = summarize_changed_nodes_from_operations(operations)
        if changed_nodes:
            return f"调整了节点 #{format_node_ranges(changed_nodes)} 的上下文。"
        return safe_label

    operation = operations[0]
    operation_type = sanitize_text(operation.get("operation_type") or "").strip()
    target_nodes = unique_int_list(operation.get("target_node_numbers") or operation.get("changed_nodes"))
    node_text = f"节点 #{format_node_ranges(target_nodes)}" if target_nodes else "当前上下文"

    target_items = operation.get("target_items")
    first_item = target_items[0] if isinstance(target_items, list) and target_items else {}
    item_number = int(first_item.get("item_number") or 0) if isinstance(first_item, dict) else 0
    item_text = f"{node_text} 的第 {item_number} 个条目" if item_number else node_text

    if operation_type == "compress_nodes":
        return f"压缩了{node_text}。"
    if operation_type == "delete_nodes":
        return f"删除了{node_text}。"
    if operation_type == "delete_item":
        return f"删除了{item_text}。"
    if operation_type == "compress_item":
        return f"压缩了{item_text}。"
    if operation_type == "replace_item":
        return f"改写了{item_text}。"

    return safe_label



def find_active_context_revision_id(revisions: list[dict[str, object]]) -> str | None:
    for revision in revisions:
        revision_id = sanitize_text(revision.get("id") or "").strip()
        if revision_id and bool(revision.get("is_active")):
            return revision_id
    return None


def mark_active_context_revision(revisions: list[dict[str, object]], revision_id: str | None) -> None:
    safe_revision_id = sanitize_text(revision_id or "").strip()
    for revision in revisions:
        current_id = sanitize_text(revision.get("id") or "").strip()
        revision["is_active"] = bool(safe_revision_id and current_id == safe_revision_id)


def coerce_context_revision_number(raw_value: Any, fallback: int, *, minimum: int = 0) -> int:
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        value = int(fallback)
    return max(minimum, value)


def has_initial_context_revision(revisions: list[dict[str, object]]) -> bool:
    return any(
        coerce_context_revision_number(revision.get("revision_number"), 1) == 0
        for revision in revisions
    )


def next_context_revision_number(revisions: list[dict[str, object]]) -> int:
    numbers = [
        coerce_context_revision_number(revision.get("revision_number"), 0)
        for revision in revisions
    ]
    return max([number for number in numbers if number > 0], default=0) + 1


def ensure_initial_context_revision(session: SessionState) -> None:
    if has_initial_context_revision(session.context_revisions):
        return
    if session.context_revisions:
        return

    session.context_revisions.append(
        build_context_revision_entry(
            transcript=normalize_transcript(session.transcript),
            context_workbench_history=normalize_context_chat_history(session.context_workbench_history),
            revision_label="初始版本",
            revision_summary="尚未压缩、删除或替换内容的完整上下文。",
            operations=[],
            revision_number=0,
        )
    )


def sync_active_context_revision_snapshot(session: SessionState) -> None:
    active_revision_id = find_active_context_revision_id(session.context_revisions)
    if not active_revision_id:
        return

    safe_snapshot = sanitize_value(normalize_transcript(session.transcript))
    safe_context_workbench_history = sanitize_value(
        normalize_context_chat_history(session.context_workbench_history)
    )
    for revision in reversed(session.context_revisions):
        current_id = sanitize_text(revision.get("id") or "").strip()
        if current_id != active_revision_id:
            continue
        revision["snapshot"] = safe_snapshot
        revision["context_workbench_history_snapshot"] = safe_context_workbench_history
        revision["node_count"] = len(session.transcript)
        return


def build_context_revision_entry(
    *,
    transcript: list[dict[str, object]],
    context_workbench_history: list[dict[str, str]],
    revision_label: str,
    revision_summary: str,
    operations: list[dict[str, object]],
    revision_number: int,
) -> dict[str, object]:
    sanitized_operations = [
        sanitize_value(operation)
        for operation in operations
        if isinstance(operation, dict)
    ]
    changed_nodes = summarize_changed_nodes_from_operations(sanitized_operations)
    change_types = [
        operation_change_type(operation)
        for operation in sanitized_operations
    ]
    label = sanitize_text(revision_label).strip() or "Context update"
    summary = sanitize_text(revision_summary).strip() or fallback_context_revision_summary(label, sanitized_operations)
    return {
        "id": uuid.uuid4().hex,
        "label": label,
        "summary": summary,
        "created_at": utc_timestamp(),
        "revision_number": coerce_context_revision_number(revision_number, 1),
        "change_type": summarize_change_type(change_types),
        "change_types": unique_text_list(change_types),
        "changed_nodes": changed_nodes,
        "operations": sanitized_operations,
        "node_count": len(transcript),
        "snapshot": sanitize_value(transcript),
        "context_workbench_history_snapshot": sanitize_value(
            normalize_context_chat_history(context_workbench_history)
        ),
        "is_active": True,
    }


def normalize_context_revision_entries(raw_entries: Any) -> list[dict[str, object]]:
    if not isinstance(raw_entries, list):
        return []

    normalized: list[dict[str, object]] = []
    for index, item in enumerate(raw_entries, start=1):
        if not isinstance(item, dict):
            continue

        revision_id = sanitize_text(item.get("id") or "").strip()
        label = sanitize_text(item.get("label") or "").strip()
        created_at = sanitize_text(item.get("created_at") or "").strip() or utc_timestamp()
        snapshot = normalize_transcript(item.get("snapshot"))
        context_workbench_history_snapshot = normalize_context_chat_history(
            item.get("context_workbench_history_snapshot")
        )
        operations = sanitize_value(item.get("operations")) if isinstance(item.get("operations"), list) else []
        if not revision_id or not label:
            continue

        changed_nodes = unique_int_list(item.get("changed_nodes")) or summarize_changed_nodes_from_operations(operations)
        change_types = unique_text_list(item.get("change_types"))
        if not change_types:
            change_types = [operation_change_type(operation) for operation in operations if isinstance(operation, dict)]
        change_type = normalize_change_type(item.get("change_type") or summarize_change_type(change_types))

        summary = sanitize_text(item.get("summary") or "").strip()
        if not summary or summary == label:
            summary = fallback_context_revision_summary(label, operations)

        normalized.append(
            {
                "id": revision_id,
                "label": label,
                "summary": summary,
                "created_at": created_at,
                "revision_number": coerce_context_revision_number(
                    item.get("revision_number"),
                    index,
                ),
                "change_type": change_type,
                "change_types": unique_text_list(change_types) or [change_type],
                "changed_nodes": changed_nodes,
                "operations": operations,
                "node_count": len(snapshot),
                "snapshot": sanitize_value(snapshot),
                "context_workbench_history_snapshot": sanitize_value(context_workbench_history_snapshot),
                "is_active": bool(item.get("is_active")),
            }
        )

    if normalized and not any(bool(revision.get("is_active")) for revision in normalized):
        normalized[-1]["is_active"] = True

    for revision_number, revision in enumerate(normalized, start=1):
        revision["revision_number"] = coerce_context_revision_number(
            revision.get("revision_number"),
            revision_number,
        )

    return normalized


def normalize_pending_context_restore(raw_restore: Any) -> dict[str, object] | None:
    if not isinstance(raw_restore, dict):
        return None

    undo_transcript = normalize_transcript(raw_restore.get("undo_transcript"))
    undo_context_workbench_history = normalize_context_chat_history(
        raw_restore.get("undo_context_workbench_history")
    )
    target_revision_id = sanitize_text(raw_restore.get("target_revision_id") or "").strip()
    target_label = sanitize_text(raw_restore.get("target_label") or "").strip()
    created_at = sanitize_text(raw_restore.get("created_at") or "").strip() or utc_timestamp()
    undo_active_revision_id = sanitize_text(raw_restore.get("undo_active_revision_id") or "").strip()
    if not undo_transcript or not target_revision_id:
        return None

    return {
        "undo_transcript": sanitize_value(undo_transcript),
        "undo_context_workbench_history": sanitize_value(undo_context_workbench_history),
        "target_revision_id": target_revision_id,
        "target_label": target_label or "Revision",
        "created_at": created_at,
        "undo_active_revision_id": undo_active_revision_id,
    }


def context_revision_summaries(revisions: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {
            "id": sanitize_text(revision.get("id") or "").strip(),
            "label": sanitize_text(revision.get("label") or "").strip() or "Revision",
            "summary": (
                lambda label, summary, operations: (
                    fallback_context_revision_summary(label, operations)
                    if not summary or summary == label
                    else summary
                )
            )(
                sanitize_text(revision.get("label") or "").strip() or "Revision",
                sanitize_text(revision.get("summary") or "").strip(),
                sanitize_value(revision.get("operations")) if isinstance(revision.get("operations"), list) else [],
            ),
            "created_at": sanitize_text(revision.get("created_at") or "").strip() or utc_timestamp(),
            "revision_number": coerce_context_revision_number(revision.get("revision_number"), 0),
            "change_type": normalize_change_type(revision.get("change_type") or "update"),
            "change_types": unique_text_list(revision.get("change_types")) or [
                normalize_change_type(revision.get("change_type") or "update")
            ],
            "changed_nodes": unique_int_list(revision.get("changed_nodes")),
            "is_active": bool(revision.get("is_active")),
            "operation_count": len(revision.get("operations") or []),
            "node_count": int(revision.get("node_count") or 0),
        }
        for revision in reversed(revisions)
        if sanitize_text(revision.get("id") or "").strip()
    ]


def context_pending_restore_payload(raw_restore: dict[str, object] | None) -> dict[str, object] | None:
    if not isinstance(raw_restore, dict):
        return None

    target_revision_id = sanitize_text(raw_restore.get("target_revision_id") or "").strip()
    if not target_revision_id:
        return None

    return {
        "target_revision_id": target_revision_id,
        "target_label": sanitize_text(raw_restore.get("target_label") or "").strip() or "Revision",
        "created_at": sanitize_text(raw_restore.get("created_at") or "").strip() or utc_timestamp(),
        "undo_active_revision_id": sanitize_text(raw_restore.get("undo_active_revision_id") or "").strip(),
        "can_undo": True,
    }


def context_record_preview(record: dict[str, object], *, limit: int = 140) -> str:
    blocks = normalize_message_blocks(record.get("blocks"))
    attachments = normalize_attachment_records(record.get("attachments"))
    text = sanitize_text(record.get("text") or "")

    if blocks:
        for block in blocks:
            kind = sanitize_text(block.get("kind") or "").strip()
            if kind == "text":
                preview = block_text_preview(block.get("text") or "", limit=limit)
                if preview:
                    return preview
                continue

            if kind != "tool":
                continue

            tool_event = block.get("tool_event")
            if not isinstance(tool_event, dict):
                continue
            tool_name = sanitize_text(tool_event.get("name") or tool_event.get("display_title") or "").strip() or "tool"
            tool_detail = block_text_preview(tool_event.get("display_detail") or "", limit=max(40, min(limit, 88)))
            if tool_detail:
                return f"{tool_name}: {tool_detail}"
            return tool_name

    if text:
        return block_text_preview(text, limit=limit)

    if attachments:
        attachment_names = ", ".join(
            sanitize_text(item.get("name") or "").strip()
            for item in attachments
            if sanitize_text(item.get("name") or "").strip()
        )
        if attachment_names:
            return f"Attachments: {attachment_names}"

    return "[empty]"


def record_tool_usage(record: dict[str, object]) -> list[dict[str, object]]:
    tool_events = sanitize_value(record.get("toolEvents")) if isinstance(record.get("toolEvents"), list) else []
    if not tool_events:
        tool_events = extract_tool_events_from_blocks(normalize_message_blocks(record.get("blocks")))

    counts: dict[str, int] = {}
    for tool_event in tool_events:
        if not isinstance(tool_event, dict):
            continue
        tool_name = sanitize_text(tool_event.get("name") or tool_event.get("display_title") or "").strip() or "tool"
        counts[tool_name] = counts.get(tool_name, 0) + 1

    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def format_tool_usage(tool_usage: list[dict[str, object]]) -> str:
    if not tool_usage:
        return "none"

    return ", ".join(
        f"{sanitize_text(item.get('name') or '').strip() or 'tool'} x{int(item.get('count') or 0)}"
        for item in tool_usage
    )


def format_token_count(token_estimate: int) -> str:
    safe_value = max(0, int(token_estimate or 0))
    if safe_value >= 1000:
        return f"{safe_value / 1000:.1f}k"
    return str(safe_value)


def record_context_tool_weight_source(record: dict[str, object]) -> str:
    parts: list[str] = []
    for block in normalize_message_blocks(record.get("blocks")):
        kind = sanitize_text(block.get("kind") or "").strip()
        if kind != "tool":
            continue

        tool_event = block.get("tool_event")
        if not isinstance(tool_event, dict):
            continue

        tool_parts = [
            sanitize_text(tool_event.get("display_title") or "").strip(),
            sanitize_text(tool_event.get("display_detail") or "").strip(),
            sanitize_text(tool_event.get("output_preview") or "").strip(),
            sanitize_text(tool_event.get("display_result") or "").strip(),
            sanitize_text(tool_event.get("raw_output") or "").strip(),
        ]
        joined = "\n".join(part for part in tool_parts if part)
        if joined:
            parts.append(joined)

    return "\n\n".join(parts)


def record_context_weight_source(record: dict[str, object]) -> str:
    parts: list[str] = []
    for block in normalize_message_blocks(record.get("blocks")):
        kind = sanitize_text(block.get("kind") or "").strip()
        if kind == "text":
            text = sanitize_text(block.get("text") or "")
            if text.strip():
                parts.append(text)
            continue

        if kind in {"reasoning", "thinking"}:
            continue

        tool_event = block.get("tool_event")
        if not isinstance(tool_event, dict):
            continue

        tool_source = record_context_tool_weight_source({"blocks": [block]})
        if tool_source:
            parts.append(tool_source)

    if not parts:
        text = sanitize_text(record.get("text") or "")
        if text.strip():
            parts.append(text)

    raw_attachments = record.get("attachments")
    attachments = raw_attachments if isinstance(raw_attachments, list) else []
    attachment_names = "\n".join(
        sanitize_text(attachment.get("name") or "").strip()
        for attachment in attachments
        if isinstance(attachment, dict) and sanitize_text(attachment.get("name") or "").strip()
    )
    if attachment_names:
        parts.append(attachment_names)

    return "\n\n".join(part for part in parts if part.strip())


def context_record_overview(record: dict[str, object], *, node_number: int, selected: bool = False) -> dict[str, object]:
    role = sanitize_text(record.get("role") or "").strip() or "unknown"
    preview = context_record_preview(record)
    tool_usage = record_tool_usage(record)
    provider_items = normalize_provider_items(record.get("providerItems"))
    token_estimate = estimate_token_count(record_context_weight_source(record))
    tool_token_estimate = estimate_token_count(record_context_tool_weight_source(record))
    return {
        "node_number": node_number,
        "role": role,
        "selected": selected,
        "preview": preview,
        "token_estimate": token_estimate,
        "tool_token_estimate": tool_token_estimate,
        "tool_usage": tool_usage,
        "tool_count": sum(int(item.get("count") or 0) for item in tool_usage),
        "item_count": len(provider_items),
        "item_types": [
            sanitize_text(item.get("type") or "").strip() or "unknown"
            for item in provider_items
        ],
        "full_text": sanitize_text(record.get("text") or "") if role == "user" else "",
    }


def context_record_details_payload(record: dict[str, object], *, node_number: int) -> dict[str, object]:
    overview = context_record_overview(record, node_number=node_number)
    provider_items = normalize_provider_items(record.get("providerItems"))
    return {
        "node_number": node_number,
        "role": overview["role"],
        "token_estimate": overview["token_estimate"],
        "tool_token_estimate": overview["tool_token_estimate"],
        "tool_usage": overview["tool_usage"],
        "preview": overview["preview"],
        "item_count": len(provider_items),
        "text": sanitize_text(record.get("text") or ""),
        "attachments": sanitize_value(normalize_attachment_records(record.get("attachments"))),
        "blocks": [
            context_detail_block(block, block_number)
            for block_number, block in enumerate(normalize_message_blocks(record.get("blocks")), start=1)
        ],
        "provider_items": provider_items,
        "items": [
            provider_item_detail(item, item_number)
            for item_number, item in enumerate(provider_items, start=1)
        ],
    }


def context_transcript_stats(transcript: list[dict[str, object]]) -> dict[str, int]:
    records = [
        record
        for record in transcript
        if isinstance(record, dict)
        and sanitize_text(record.get("role") or "").strip() in {"user", "assistant"}
    ]
    overviews = [
        context_record_overview(record, node_number=index)
        for index, record in enumerate(records, start=1)
    ]
    return {
        "node_count": len(records),
        "token_count": sum(int(item.get("token_estimate") or 0) for item in overviews),
        "tool_token_count": sum(int(item.get("tool_token_estimate") or 0) for item in overviews),
    }


def build_context_workspace_snapshot(
    session: SessionState,
    *,
    selected_indexes: list[int] | None = None,
) -> str:
    safe_selected_indexes = normalize_selected_node_indexes(selected_indexes or [], len(session.transcript))
    selected_numbers = [index + 1 for index in safe_selected_indexes]
    lines = [
        "# 当前上下文快照",
        f"- 会话标题：{session.title}",
        f"- 会话类型：{session.scope}",
        f"- 当前节点数：{len(session.transcript)}",
        f"- 当前选中节点：{format_node_ranges(selected_numbers) or '未单独选中，默认面向全局'}",
        "- 本轮里的所有 Node # 都以这份快照为准。",
        "- user 节点直接给全文，assistant 节点默认只给概览。",
        "- 如果需要 assistant 节点的完整协议层细节，再调用 get_context_node_details。",
        "",
        "## 节点概览",
    ]

    for node_number, record in enumerate(session.transcript, start=1):
        overview = context_record_overview(
            record,
            node_number=node_number,
            selected=(node_number - 1) in safe_selected_indexes,
        )
        marker = " | selected" if overview["selected"] else ""
        token_label = format_token_count(int(overview["token_estimate"] or 0))
        tool_token_estimate = int(overview.get("tool_token_estimate") or 0)
        tool_token_label = (
            f" | tool {format_token_count(tool_token_estimate)} tokens"
            if tool_token_estimate > 0
            else ""
        )
        if overview["role"] == "user":
            user_text = sanitize_text(overview["full_text"] or "").strip() or "[empty]"
            lines.append(f"- Node #{node_number} | user{marker} | {token_label} tokens")
            lines.append("  content:")
            for content_line in user_text.splitlines() or ["[empty]"]:
                lines.append(f"    {content_line}")
            continue

        lines.append(
            f"- Node #{node_number} | assistant{marker} | {token_label} tokens{tool_token_label} | {format_tool_usage(overview['tool_usage'])} | {int(overview['item_count'] or 0)} items"
        )
        lines.append(f"  preview: {sanitize_text(overview['preview'] or '') or '[empty]'}")

    return "\n".join(lines).strip()


def format_node_ranges(node_numbers: list[int]) -> str:
    if not node_numbers:
        return ""

    ordered = sorted(set(node_numbers))
    segments: list[str] = []
    range_start = ordered[0]
    previous = ordered[0]
    for current in ordered[1:]:
        if current == previous + 1:
            previous = current
            continue
        segments.append(f"{range_start}" if range_start == previous else f"{range_start}-{previous}")
        range_start = current
        previous = current
    segments.append(f"{range_start}" if range_start == previous else f"{range_start}-{previous}")
    return ", ".join(segments)


def letter_index(value: int) -> str:
    result = ""
    current = max(1, value)
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        result = f"{chr(65 + remainder)}{result}"
    return result


@dataclass(slots=True)
class ContextWorkbenchDraftNode:
    order: float
    label: str
    record: dict[str, object]
    active: bool
    source_node_number: int | None = None
    kind: str = "existing"
    status: str = "active"


class ContextWorkbenchDraft:
    def __init__(self, transcript: list[dict[str, object]], selected_indexes: list[int]) -> None:
        safe_selected = normalize_selected_node_indexes(selected_indexes, len(transcript))
        self.selected_node_numbers = [index + 1 for index in safe_selected]
        self.nodes = [
            ContextWorkbenchDraftNode(
                order=float(node_number),
                label=f"Node #{node_number}",
                record=sanitize_value(record),
                active=True,
                source_node_number=node_number,
            )
            for node_number, record in enumerate(transcript, start=1)
        ]
        self.operations: list[dict[str, object]] = []
        self._draft_counter = 0
        self._revision_summary = ""
        self._working_version = 0

    @property
    def has_changes(self) -> bool:
        return bool(self.operations)

    def _record_operation(self, operation: dict[str, object]) -> None:
        self._working_version += 1
        operation["working_version"] = self._working_version
        self.operations.append(operation)
        self._revision_summary = ""

    def set_revision_summary(self, summary: str) -> dict[str, object]:
        if not self.operations:
            raise ValueError("no working snapshot edits exist yet")

        safe_summary = re.sub(r"\s+", " ", sanitize_text(summary)).strip()
        if not safe_summary:
            raise ValueError("summary is required")
        if len(safe_summary) > 220:
            safe_summary = f"{safe_summary[:219].rstrip()}..."

        self._revision_summary = safe_summary
        return {
            "payload_kind": "revision_summary",
            "saved": True,
            "summary": safe_summary,
            "change_count": len(self.operations),
            "working_version": self._working_version,
        }

    def _fallback_revision_summary(self) -> str:
        if not self.operations:
            return "这次更新了当前上下文。"
        return fallback_context_revision_summary("Context update", self.operations)

    def revision_summary(self) -> str:
        return self._revision_summary or self._fallback_revision_summary()

    def active_nodes(self) -> list[ContextWorkbenchDraftNode]:
        return [node for node in sorted(self.nodes, key=lambda item: item.order) if node.active]

    def max_node_number(self) -> int:
        return max((node.source_node_number or 0) for node in self.nodes) if self.nodes else 0

    def _nodes_by_number(self, node_numbers: list[int], *, include_inactive: bool = False) -> list[ContextWorkbenchDraftNode]:
        targets: list[ContextWorkbenchDraftNode] = []
        for node_number in node_numbers:
            node = next(
                (
                    item
                    for item in self.nodes
                    if item.source_node_number == node_number and (include_inactive or item.active)
                ),
                None,
            )
            if node is not None:
                targets.append(node)
        return targets

    def node_details(self, nodes: list[ContextWorkbenchDraftNode]) -> list[dict[str, object]]:
        details: list[dict[str, object]] = []
        for node in nodes:
            detail = context_record_details_payload(node.record, node_number=node.source_node_number or 1)
            detail["payload_kind"] = "node_detail"
            detail["node_number"] = node.source_node_number
            detail["label"] = node.label
            detail["status"] = node.status
            detail["active"] = node.active
            detail["node_kind"] = node.kind
            details.append(detail)
        return details

    def _next_draft_label(self) -> str:
        self._draft_counter += 1
        return f"Draft Node {letter_index(self._draft_counter)}"

    def _set_node_record(self, node: ContextWorkbenchDraftNode, record: dict[str, object], *, status: str = "updated") -> None:
        normalized_record = normalize_transcript([record])
        if not normalized_record:
            raise ValueError("record could not be normalized after mutation")
        node.record = normalized_record[0]
        if node.kind == "existing":
            node.status = status

    def _provider_items_for_node(self, node: ContextWorkbenchDraftNode) -> list[dict[str, Any]]:
        return normalize_provider_items(node.record.get("providerItems"))

    def _make_insert_provider_item(
        self,
        node: ContextWorkbenchDraftNode,
        insertion: dict[str, Any],
    ) -> dict[str, Any]:
        content = sanitize_text(insertion.get("content") or "").strip()
        role = sanitize_text(node.record.get("role") or "user").strip()
        safe_role = role if role in {"user", "assistant"} else "user"
        return {"type": "message", "role": safe_role, "content": content}

    def apply_write_nodes(
        self,
        delete_numbers: list[int],
        inserts: list[dict[str, Any]],
    ) -> dict[str, object]:
        safe_deletes = sorted(set(number for number in delete_numbers if number > 0))
        active_deletes = [node for node in self._nodes_by_number(safe_deletes) if node.active]
        if len(active_deletes) != len(safe_deletes):
            raise ValueError("one or more delete targets do not exist in the current snapshot")

        anchor_order_counts: dict[float, int] = {}
        created_nodes: list[ContextWorkbenchDraftNode] = []
        for insertion in inserts:
            try:
                after = int(insertion.get("after") or 0)
            except (TypeError, ValueError):
                after = 0
            if after <= 0:
                anchor_order = 0.0
            else:
                anchor = next(
                    (node for node in self.nodes if node.source_node_number == after),
                    None,
                )
                if anchor is None:
                    raise ValueError(f"Node #{after} is not a valid insertion anchor")
                anchor_order = anchor.order

            content = sanitize_text(insertion.get("content") or "").strip()
            if not content:
                raise ValueError("insert content is required")
            raw_role = sanitize_text(insertion.get("role") or "user").strip()
            role = raw_role if raw_role in {"user", "assistant"} else "user"

            anchor_order_counts[anchor_order] = anchor_order_counts.get(anchor_order, 0) + 1
            created_node = ContextWorkbenchDraftNode(
                order=anchor_order + (0.001 * anchor_order_counts[anchor_order]),
                label=self._next_draft_label(),
                record={
                    "role": role,
                    "text": content,
                    "attachments": [],
                    "toolEvents": [],
                    "blocks": [{"kind": "text", "text": content}],
                    "providerItems": [{"type": "message", "role": role, "content": content}],
                },
                active=True,
                source_node_number=None,
                kind="draft",
                status="created",
            )
            self.nodes.append(created_node)
            created_nodes.append(created_node)

        deleted_numbers: list[int] = []
        for node in active_deletes:
            node.active = False
            node.status = "deleted"
            if node.source_node_number is not None:
                deleted_numbers.append(node.source_node_number)

        summary_parts: list[str] = []
        if deleted_numbers:
            summary_parts.append(f"Delete #{format_node_ranges(deleted_numbers)}")
        if created_nodes:
            summary_parts.append(f"Insert {len(created_nodes)} node(s)")
        summary = ", ".join(summary_parts) or "No changes"

        if deleted_numbers or created_nodes:
            change_type = "compress" if deleted_numbers and created_nodes else (
                "delete" if deleted_numbers else "replace"
            )
            self._record_operation(
                {
                    "operation_type": "write_nodes",
                    "change_type": change_type,
                    "label": summary,
                    "summary": summary,
                    "changed_nodes": deleted_numbers,
                    "target_node_numbers": deleted_numbers,
                    "inserted_node_count": len(created_nodes),
                }
            )

        return {
            "summary": summary,
            "deleted": deleted_numbers,
            "inserted": len(created_nodes),
        }

    def apply_write_items(
        self,
        node_number: int,
        delete_item_numbers: list[int],
        inserts: list[dict[str, Any]],
    ) -> dict[str, object]:
        nodes = self._nodes_by_number([node_number])
        if not nodes:
            raise ValueError(f"Node #{node_number} was not found")
        node = nodes[0]
        provider_items = list(self._provider_items_for_node(node))
        safe_deletes = sorted(
            set(number for number in delete_item_numbers if 1 <= number <= len(provider_items))
        )
        if len(safe_deletes) != len(set(delete_item_numbers)):
            raise ValueError("one or more item numbers are outside the current node")

        inserts_by_anchor: dict[int, list[dict[str, Any]]] = {}
        for insertion in inserts:
            try:
                after = int(insertion.get("after") or 0)
            except (TypeError, ValueError):
                after = 0
            if after < 0 or after > len(provider_items):
                raise ValueError(f"item #{after} is not a valid insertion anchor")
            if not sanitize_text(insertion.get("content") or "").strip():
                raise ValueError("insert content is required")
            inserts_by_anchor.setdefault(after, []).append(insertion)

        delete_set = set(safe_deletes)
        next_items: list[dict[str, Any]] = [
            self._make_insert_provider_item(node, insertion)
            for insertion in inserts_by_anchor.get(0, [])
        ]
        for index, provider_item in enumerate(provider_items, start=1):
            if index not in delete_set:
                next_items.append(provider_item)
            next_items.extend(
                self._make_insert_provider_item(node, insertion)
                for insertion in inserts_by_anchor.get(index, [])
            )

        if not safe_deletes and not inserts:
            return {
                "applied": False,
                "node": node_number,
                "items_deleted": 0,
                "items_inserted": 0,
            }

        self._set_node_record(node, compile_record_from_provider_items(node.record, next_items))
        summary = (
            f"Edit items in Node #{node_number} "
            f"(delete {len(safe_deletes)}, insert {len(inserts)})"
        )
        self._record_operation(
            {
                "operation_type": "write_items",
                "change_type": "compress" if inserts else "delete",
                "label": summary,
                "summary": summary,
                "changed_nodes": [node_number],
                "target_node_numbers": [node_number],
                "deleted_item_numbers": safe_deletes,
                "inserted_item_count": len(inserts),
            }
        )
        return {
            "applied": True,
            "node": node_number,
            "items_deleted": len(safe_deletes),
            "items_inserted": len(inserts),
        }

    def build_draft_snapshot_text(self, session_title: str) -> str:
        active_nodes = self.active_nodes()
        lines = [
            "# 当前主 Agent 上下文快照（已更新）",
            f"- 会话标题：{sanitize_text(session_title).strip() or '未命名会话'}",
            f"- 当前节点数：{len(active_nodes)}",
            "",
            "## 节点概览",
        ]
        for display_number, node in enumerate(active_nodes, start=1):
            overview = context_record_overview(
                node.record,
                node_number=display_number,
                selected=(node.source_node_number or 0) in self.selected_node_numbers,
            )
            role = sanitize_text(overview.get("role") or "unknown").strip() or "unknown"
            token_label = format_token_count(int(overview.get("token_estimate") or 0))
            new_mark = " [new]" if node.kind == "draft" else ""
            lines.append(f"- Node #{display_number}{new_mark} | {role} | {token_label} tokens")
            if role == "assistant":
                lines.append(
                    f"  preview: {sanitize_text(overview.get('preview') or '').strip() or '[empty]'}"
                )
            else:
                full_text = sanitize_text(overview.get("full_text") or "").strip() or "[empty]"
                lines.extend(f"  {line}" for line in full_text.splitlines())
        return "\n".join(lines).strip()

    def committed_transcript(self) -> list[dict[str, object]]:
        return normalize_transcript([node.record for node in self.active_nodes()])

    def revision_label(self) -> str:
        if not self.operations:
            return "Context update"
        if len(self.operations) == 1:
            return sanitize_text(self.operations[0].get("summary") or self.operations[0].get("label") or "").strip() or "Context update"
        first_label = sanitize_text(
            self.operations[0].get("summary") or self.operations[0].get("label") or ""
        ).strip() or "Context update"
        return f"{first_label} + {len(self.operations) - 1} more"


class ContextWorkbenchToolRegistry:
    def __init__(
        self,
        draft: ContextWorkbenchDraft,
        session_title: str = "",
        *,
        review_mode: bool = False,
    ) -> None:
        self.draft = draft
        self._session_title = sanitize_text(session_title).strip()
        self.review_mode = review_mode
        self.review_rationale = ""
        self._review_write_completed = False
        self._expanded_node_numbers: set[int] = set()
        self._tools = {
            definition.name: definition
            for definition in (
                [self._build_write_nodes_tool_v2()]
                if review_mode
                else [
                    self._build_get_nodes_tool_v2(),
                    self._build_write_nodes_tool_v2(),
                    self._build_write_items_tool_v2(),
                ]
            )
        }

    @property
    def schemas(self) -> list[dict[str, Any]]:
        return [tool.to_schema() for tool in self._tools.values()]

    @classmethod
    def tool_catalog(cls) -> list[dict[str, str]]:
        return [
            {
                "id": "get_nodes",
                "label": "读取节点",
                "description": "按需展开一个或多个节点的完整结构和 provider items。",
                "status": "available",
            },
            {
                "id": "write_nodes",
                "label": "批量编辑节点",
                "description": "一次完成节点删除、插入、替换或压缩，并返回更新后的草稿快照。",
                "status": "available",
            },
            {
                "id": "write_items",
                "label": "编辑节点条目",
                "description": "在确有必要时编辑单个节点内部的 item。",
                "status": "available",
            },
        ]

    def execute(self, name: str, arguments: dict[str, Any]) -> ToolExecution:
        tool = self._tools.get(name)
        if tool is None:
            return ToolExecution(
                output_text=json.dumps({"error": f"unknown workbench tool: {name}"}, ensure_ascii=False),
                display_title=name,
                display_detail="unknown context workbench tool",
                display_result="The requested context workbench tool does not exist.",
                status="error",
            )

        try:
            return tool.handler(arguments)
        except Exception as exc:  # noqa: BLE001
            return ToolExecution(
                output_text=json.dumps({"error": str(exc), "tool": name}, ensure_ascii=False),
                display_title=tool.label,
                display_detail="context workbench tool failed",
                display_result=sanitize_text(str(exc) or "The context workbench tool failed."),
                status="error",
            )

    def _build_get_nodes_tool_v2(self) -> ContextWorkbenchToolDefinition:
        def handler(arguments: dict[str, Any]) -> ToolExecution:
            raw_numbers = arguments.get("node_numbers")
            if not isinstance(raw_numbers, list) or not raw_numbers:
                raise ValueError("node_numbers is required")
            node_numbers = normalize_node_numbers(raw_numbers, self.draft.max_node_number())
            nodes = self.draft._nodes_by_number(node_numbers)
            if len(nodes) != len(node_numbers):
                raise ValueError("one or more nodes do not exist in the current snapshot")
            details = self.draft.node_details(nodes)
            self._expanded_node_numbers.update(node_numbers)
            label = ", ".join(f"Node #{number}" for number in node_numbers)
            return ToolExecution(
                output_text=json.dumps({"nodes": details}, ensure_ascii=False),
                display_title="读取节点",
                display_detail=label,
                display_result=f"已返回 {label} 的完整内容。",
                status="completed",
            )

        return ContextWorkbenchToolDefinition(
            name="get_nodes",
            label="读取节点",
            description=(
                "Expand one or more nodes into full structured item details. "
                "Use this before editing assistant nodes; non-assistant full text is already in the snapshot."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "node_numbers": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "1-based Node # values from the current round's initial snapshot.",
                    }
                },
                "required": ["node_numbers"],
                "additionalProperties": False,
            },
            status="available",
            handler=handler,
        )

    def _build_write_nodes_tool_v2(self) -> ContextWorkbenchToolDefinition:
        def handler(arguments: dict[str, Any]) -> ToolExecution:
            raw_delete = arguments.get("delete") or []
            raw_inserts = arguments.get("inserts") or []
            if not isinstance(raw_delete, list) or not isinstance(raw_inserts, list):
                raise ValueError("delete and inserts must be arrays")
            delete_numbers = [
                int(number)
                for number in raw_delete
                if isinstance(number, (int, float)) and int(number) > 0
            ]
            inserts = [item for item in raw_inserts if isinstance(item, dict)]
            if len(delete_numbers) != len(raw_delete) or len(inserts) != len(raw_inserts):
                raise ValueError("delete and inserts contain invalid entries")
            if not delete_numbers and not inserts:
                raise ValueError("provide delete and/or inserts")

            if self.review_mode:
                if self._review_write_completed:
                    raise ValueError("automatic context review accepts exactly one write_nodes proposal")
                self.review_rationale = re.sub(
                    r"\s+",
                    " ",
                    sanitize_text(arguments.get("review_rationale") or ""),
                ).strip()
                if not self.review_rationale:
                    raise ValueError("review_rationale is required")

            result = self.draft.apply_write_nodes(delete_numbers, inserts)
            self._expanded_node_numbers.clear()
            if self.review_mode:
                self._review_write_completed = True
                self.draft.set_revision_summary(self.review_rationale)
            return ToolExecution(
                output_text=json.dumps(
                    {
                        "result": result,
                        "updated_snapshot": self.draft.build_draft_snapshot_text(self._session_title),
                    },
                    ensure_ascii=False,
                ),
                display_title="批量编辑节点",
                display_detail=sanitize_text(result.get("summary") or ""),
                display_result=sanitize_text(result.get("summary") or "节点已更新。"),
                status="completed",
            )

        properties: dict[str, Any] = {
            "delete": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Node numbers to delete from the initial snapshot.",
            },
            "inserts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "after": {
                            "type": "integer",
                            "description": (
                                "Initial snapshot anchor. Use 0 for the beginning; the anchor remains valid "
                                "even when it is also deleted."
                            ),
                        },
                        "role": {
                            "type": "string",
                            "enum": ["user", "assistant"],
                            "description": "Role for the new node. Defaults to user.",
                        },
                        "content": {
                            "type": "string",
                            "description": "Markdown content for the new node.",
                        },
                    },
                    "required": ["after", "content"],
                    "additionalProperties": False,
                },
            },
        }
        required: list[str] = []
        if self.review_mode:
            properties["review_rationale"] = {
                "type": "string",
                "description": (
                    "A user-facing proposal rationale. Explain what old material should be consolidated, "
                    "how it relates to the current task, what decisions or unfinished work remain, and any risk. "
                    "Use proposal language and never mention node numbers, tokens, tools, or draft mechanics."
                ),
            }
            required = ["review_rationale"]

        return ContextWorkbenchToolDefinition(
            name="write_nodes",
            label="批量编辑节点",
            description=(
                "Submit the complete selective context-maintenance proposal in one call."
                if self.review_mode
                else (
                    "Delete and/or insert nodes in the working snapshot. All references use the initial "
                    "snapshot for this round. Prefer one complete batch and inspect updated_snapshot."
                )
            ),
            parameters={
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
            status="available",
            handler=handler,
        )

    def _build_write_items_tool_v2(self) -> ContextWorkbenchToolDefinition:
        def handler(arguments: dict[str, Any]) -> ToolExecution:
            try:
                node_number = int(arguments.get("node_number") or 0)
            except (TypeError, ValueError):
                node_number = 0
            if node_number <= 0:
                raise ValueError("node_number is required")
            if node_number not in self._expanded_node_numbers:
                raise ValueError("call get_nodes for this node before editing its items")
            raw_delete = arguments.get("delete") or []
            raw_inserts = arguments.get("inserts") or []
            if not isinstance(raw_delete, list) or not isinstance(raw_inserts, list):
                raise ValueError("delete and inserts must be arrays")
            delete_numbers = [
                int(number)
                for number in raw_delete
                if isinstance(number, (int, float)) and int(number) > 0
            ]
            inserts = [item for item in raw_inserts if isinstance(item, dict)]
            if len(delete_numbers) != len(raw_delete) or len(inserts) != len(raw_inserts):
                raise ValueError("delete and inserts contain invalid entries")
            if not delete_numbers and not inserts:
                raise ValueError("provide delete and/or inserts")
            result = self.draft.apply_write_items(node_number, delete_numbers, inserts)
            self._expanded_node_numbers.discard(node_number)
            return ToolExecution(
                output_text=json.dumps(result, ensure_ascii=False),
                display_title="编辑节点条目",
                display_detail=f"Node #{node_number}",
                display_result=(
                    f"Node #{node_number}：删除 {result['items_deleted']} 项，"
                    f"插入 {result['items_inserted']} 项。"
                ),
                status="completed",
            )

        return ContextWorkbenchToolDefinition(
            name="write_items",
            label="编辑节点条目",
            description=(
                "Delete and/or insert provider items inside one node. Call get_nodes first and only use "
                "this when node-level editing cannot preserve the required assistant structure."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "node_number": {"type": "integer"},
                    "delete": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "1-based item numbers from get_nodes.",
                    },
                    "inserts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "after": {
                                    "type": "integer",
                                    "description": "Original item anchor; use 0 for the beginning.",
                                },
                                "content": {"type": "string"},
                            },
                            "required": ["after", "content"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["node_number"],
                "additionalProperties": False,
            },
            status="available",
            handler=handler,
        )


def normalize_context_chat_history(raw_history: Any) -> list[dict[str, str]]:
    if not isinstance(raw_history, list):
        return []

    history: list[dict[str, str]] = []
    for item in raw_history:
        if not isinstance(item, dict):
            continue
        role = sanitize_text(item.get("role") or "").strip()
        if role not in {"user", "assistant"}:
            continue
        content = sanitize_text(item.get("content") or "").strip()
        if not content:
            continue
        history.append(
            {
                "role": role,
                "content": content,
            }
        )
    return history


def prepare_context_chat_history_for_model(raw_history: Any, *, limit: int = 12) -> list[dict[str, str]]:
    history = normalize_context_chat_history(raw_history)
    filtered: list[dict[str, str]] = []

    for item in history:
        if item["role"] == "assistant":
            content = sanitize_text(item["content"])
            if "我已经读完当前上下文了，但这次没能稳定产出文字答复" in content:
                continue
        filtered.append(item)

    if limit > 0:
        return filtered[-limit:]
    return filtered
