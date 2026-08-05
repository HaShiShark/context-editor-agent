from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from app_agent.session_agent import SessionAgent, sanitize_text

from .attachments import attachment_inputs_from_records, normalize_attachment_records
from .serialization import sanitize_value


def fallback_blocks_from_text_and_tools(
    role: str,
    text: str,
    tool_events: list[dict[str, object]],
) -> list[dict[str, object]]:
    blocks: list[dict[str, object]] = []
    safe_text = sanitize_text(text)

    if safe_text:
        blocks.append(
            {
                "kind": "text",
                "text": safe_text,
            }
        )

    if role == "assistant":
        for tool_event in tool_events:
            blocks.append(
                {
                    "kind": "tool",
                    "tool_event": sanitize_value(tool_event),
                }
            )

    return blocks


def _find_tag(value: str, tag: str) -> int:
    return value.lower().find(tag)


def _safe_emit_split(value: str, tag: str) -> tuple[str, str]:
    lower_value = value.lower()
    max_suffix_length = min(len(value), len(tag) - 1)
    for suffix_length in range(max_suffix_length, 0, -1):
        if tag.startswith(lower_value[-suffix_length:]):
            return value[:-suffix_length], value[-suffix_length:]
    return value, ""


class ThinkTagStreamParser:
    def __init__(
        self,
        *,
        on_text_delta: Callable[[str], None],
        on_reasoning_start: Callable[[], None],
        on_reasoning_delta: Callable[[str], None],
        on_reasoning_done: Callable[[], None],
    ) -> None:
        self.on_text_delta = on_text_delta
        self.on_reasoning_start = on_reasoning_start
        self.on_reasoning_delta = on_reasoning_delta
        self.on_reasoning_done = on_reasoning_done
        self.buffer = ""
        self.in_reasoning = False

    def feed(self, delta: str) -> None:
        safe_delta = sanitize_text(delta)
        if not safe_delta:
            return

        self.buffer = f"{self.buffer}{safe_delta}"
        self._drain()

    def finish(self) -> None:
        if self.buffer:
            if self.in_reasoning:
                self.on_reasoning_delta(self.buffer)
            else:
                self.on_text_delta(self.buffer)
            self.buffer = ""

        if self.in_reasoning:
            self.in_reasoning = False
            self.on_reasoning_done()

    def _drain(self) -> None:
        while self.buffer:
            if self.in_reasoning:
                close_index = _find_tag(self.buffer, "</think>")
                if close_index >= 0:
                    before_close = self.buffer[:close_index]
                    if before_close:
                        self.on_reasoning_delta(before_close)
                    self.buffer = self.buffer[close_index + len("</think>") :]
                    self.in_reasoning = False
                    self.on_reasoning_done()
                    continue

                emit_text, retained = _safe_emit_split(self.buffer, "</think>")
                if emit_text:
                    self.on_reasoning_delta(emit_text)
                self.buffer = retained
                return

            open_index = _find_tag(self.buffer, "<think>")
            if open_index >= 0:
                before_open = self.buffer[:open_index]
                if before_open:
                    self.on_text_delta(before_open)
                self.buffer = self.buffer[open_index + len("<think>") :]
                self.in_reasoning = True
                self.on_reasoning_start()
                continue

            emit_text, retained = _safe_emit_split(self.buffer, "<think>")
            if emit_text:
                self.on_text_delta(emit_text)
            self.buffer = retained
            return


def blocks_from_text_and_tools(
    role: str,
    text: str,
    tool_events: list[dict[str, object]],
) -> list[dict[str, object]]:
    if role != "assistant":
        return fallback_blocks_from_text_and_tools(role, text, tool_events)

    blocks: list[dict[str, object]] = []
    active_reasoning_index: int | None = None

    def append_text_delta(delta: str) -> None:
        safe_delta = sanitize_text(delta)
        if not safe_delta:
            return
        if blocks and blocks[-1].get("kind") == "text":
            blocks[-1]["text"] = sanitize_text(f"{blocks[-1].get('text', '')}{safe_delta}")
            return
        blocks.append({"kind": "text", "text": safe_delta})

    def start_reasoning() -> None:
        nonlocal active_reasoning_index
        if active_reasoning_index is not None:
            return
        blocks.append({"kind": "reasoning", "text": "", "status": "streaming"})
        active_reasoning_index = len(blocks) - 1

    def append_reasoning_delta(delta: str) -> None:
        nonlocal active_reasoning_index
        safe_delta = sanitize_text(delta)
        if not safe_delta:
            return
        if active_reasoning_index is None:
            start_reasoning()
        if active_reasoning_index is None:
            return
        block = blocks[active_reasoning_index]
        block["text"] = sanitize_text(f"{block.get('text', '')}{safe_delta}")

    def finish_reasoning() -> None:
        nonlocal active_reasoning_index
        if active_reasoning_index is None:
            return
        blocks[active_reasoning_index]["status"] = "completed"
        active_reasoning_index = None

    parser = ThinkTagStreamParser(
        on_text_delta=append_text_delta,
        on_reasoning_start=start_reasoning,
        on_reasoning_delta=append_reasoning_delta,
        on_reasoning_done=finish_reasoning,
    )
    parser.feed(text)
    parser.finish()

    for tool_event in tool_events:
        blocks.append(
            {
                "kind": "tool",
                "tool_event": sanitize_value(tool_event),
            }
        )

    return blocks


def normalize_message_blocks(raw_blocks: Any) -> list[dict[str, object]]:
    if not isinstance(raw_blocks, list):
        return []

    normalized: list[dict[str, object]] = []
    for item in raw_blocks:
        if not isinstance(item, dict):
            continue

        kind = sanitize_text(item.get("kind") or "").strip()
        if kind == "text":
            text = sanitize_text(item.get("text") or "")
            if not text:
                continue
            normalized.append(
                {
                    "kind": "text",
                    "text": text,
                }
            )
            continue

        if kind == "reasoning":
            text = sanitize_text(item.get("text") or "")
            status = sanitize_text(item.get("status") or "").strip() or "completed"
            if not text and status != "streaming":
                continue
            normalized.append(
                {
                    "kind": "reasoning",
                    "text": text,
                    "status": "streaming" if status == "streaming" else "completed",
                }
            )
            continue

        if kind == "tool" and isinstance(item.get("tool_event"), dict):
            normalized.append(
                {
                    "kind": "tool",
                    "tool_event": sanitize_value(item.get("tool_event")),
                }
            )

    return normalized


def extract_tool_events_from_blocks(blocks: list[dict[str, object]]) -> list[dict[str, object]]:
    tool_events: list[dict[str, object]] = []
    for block in blocks:
        if sanitize_text(block.get("kind") or "").strip() != "tool":
            continue
        tool_event = block.get("tool_event")
        if isinstance(tool_event, dict):
            tool_events.append(sanitize_value(tool_event))
    return tool_events


def append_tool_provider_items(
    provider_items: list[dict[str, Any]],
    *,
    tool_event: dict[str, object],
    record_index: int,
    tool_index: int,
) -> None:
    safe_tool_event = sanitize_value(tool_event)
    tool_name = sanitize_text(safe_tool_event.get("name") or "").strip() or f"tool_{tool_index}"
    call_id = f"stored_{record_index}_{tool_index}"
    arguments_value = safe_tool_event.get("arguments")

    if isinstance(arguments_value, str):
        arguments_text = sanitize_text(arguments_value) or "{}"
    else:
        arguments_text = json.dumps(sanitize_value(arguments_value), ensure_ascii=False)

    tool_output = (
        sanitize_text(safe_tool_event.get("raw_output") or "")
        or sanitize_text(safe_tool_event.get("display_result") or "")
        or sanitize_text(safe_tool_event.get("output_preview") or "")
    )

    provider_items.append(
        {
            "type": "function_call",
            "call_id": call_id,
            "name": tool_name,
            "arguments": arguments_text or "{}",
        }
    )
    provider_items.append(
        {
            "type": "function_call_output",
            "call_id": call_id,
            "output": tool_output,
        }
    )


def flush_assistant_text_buffer(
    provider_items: list[dict[str, Any]],
    text_buffer: list[str],
) -> None:
    if not text_buffer:
        return

    provider_items.append(
        SessionAgent._message(
            "assistant",
            "".join(text_buffer),
        )
    )
    text_buffer.clear()


def normalize_provider_items(raw_items: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_items, list):
        return []

    normalized: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue

        item_type = sanitize_text(item.get("type") or "").strip()
        if item_type == "message":
            role = sanitize_text(item.get("role") or "").strip()
            if role not in {"system", "developer", "user", "assistant"}:
                continue

            content = item.get("content")
            if isinstance(content, list):
                safe_content = sanitize_value(content)
            else:
                safe_content = sanitize_text(content or "")

            normalized.append(
                {
                    "type": "message",
                    "role": role,
                    "content": safe_content,
                }
            )
            continue

        if item_type == "function_call":
            call_id = sanitize_text(item.get("call_id") or "").strip()
            name = sanitize_text(item.get("name") or "").strip()
            if not call_id or not name:
                continue

            normalized.append(
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": sanitize_text(item.get("arguments") or "{}") or "{}",
                }
            )
            continue

        if item_type == "function_call_output":
            call_id = sanitize_text(item.get("call_id") or "").strip()
            if not call_id:
                continue

            normalized.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": sanitize_text(item.get("output") or ""),
                }
            )

    return normalized


def assistant_provider_items_from_history_slice(raw_items: Any) -> list[dict[str, Any]]:
    provider_items = normalize_provider_items(raw_items)
    if provider_items and sanitize_text(provider_items[0].get("type") or "").strip() == "message":
        first_role = sanitize_text(provider_items[0].get("role") or "").strip()
        if first_role == "user":
            provider_items = provider_items[1:]
    return provider_items


def sanitize_provider_input_item(raw_item: Any) -> dict[str, Any] | None:
    if not isinstance(raw_item, dict):
        return None

    safe_item = sanitize_value(raw_item)
    return safe_item if isinstance(safe_item, dict) else None


def provider_input_item_text(item: dict[str, Any]) -> str:
    item_type = sanitize_text(item.get("type") or "").strip()
    if item_type == "message":
        return extract_text_from_provider_message_content(item.get("content"))

    if item_type == "function_call":
        name = sanitize_text(item.get("name") or "").strip() or "tool"
        arguments = sanitize_text(item.get("arguments") or "{}").strip() or "{}"
        return f"{name}({arguments})"

    if item_type == "function_call_output":
        return sanitize_text(item.get("output") or "")

    if item_type in {"compaction", "compaction_summary"}:
        for key in ("summary", "content", "text"):
            text = sanitize_text(item.get(key) or "").strip()
            if text:
                return text

    if item_type == "reasoning":
        for key in ("summary", "content", "text"):
            text = sanitize_text(item.get(key) or "").strip()
            if text:
                return text

    return json.dumps(item, ensure_ascii=False)


def input_context_record(
    *,
    role: str,
    text: str,
    provider_items: list[dict[str, Any]],
    blocks: list[dict[str, object]] | None = None,
    tool_events: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    safe_text = sanitize_text(text)
    safe_blocks = normalize_message_blocks(blocks)
    safe_tool_events = sanitize_value(tool_events or [])
    if not safe_blocks:
        safe_blocks = blocks_from_text_and_tools(
            "assistant" if role == "assistant" else "user",
            safe_text,
            safe_tool_events if isinstance(safe_tool_events, list) else [],
        )
    return {
        "role": sanitize_text(role).strip() or "context",
        "text": safe_text,
        "attachments": [],
        "toolEvents": safe_tool_events if isinstance(safe_tool_events, list) else [],
        "blocks": safe_blocks,
        "providerItems": sanitize_value(provider_items),
    }


def provider_input_to_context_records(raw_items: Any) -> list[dict[str, object]]:
    if not isinstance(raw_items, list):
        return []

    records: list[dict[str, object]] = []
    assistant_items: list[dict[str, Any]] = []

    def flush_assistant_items() -> None:
        if not assistant_items:
            return

        compiled = compile_record_from_provider_items(
            {"role": "assistant", "attachments": []},
            normalize_provider_items(assistant_items),
        )
        text = sanitize_text(compiled.get("text") or "").strip()
        if not text:
            text = "\n\n".join(
                part
                for part in (provider_input_item_text(item) for item in assistant_items)
                if part.strip()
            )
        records.append(
            input_context_record(
                role="assistant",
                text=text,
                provider_items=list(assistant_items),
                blocks=normalize_message_blocks(compiled.get("blocks")),
                tool_events=sanitize_value(compiled.get("toolEvents"))
                if isinstance(compiled.get("toolEvents"), list)
                else [],
            )
        )
        assistant_items.clear()

    for raw_item in raw_items:
        item = sanitize_provider_input_item(raw_item)
        if item is None:
            continue

        item_type = sanitize_text(item.get("type") or "").strip()
        role = sanitize_text(item.get("role") or "").strip()
        is_assistant_protocol_item = (
            (item_type == "message" and role == "assistant")
            or item_type in {"function_call", "function_call_output", "reasoning"}
        )

        if is_assistant_protocol_item:
            assistant_items.append(item)
            continue

        flush_assistant_items()

        if item_type == "message" and role in {"system", "developer", "user"}:
            text = provider_input_item_text(item)
            records.append(
                input_context_record(
                    role=role,
                    text=text,
                    provider_items=[item],
                )
            )
            continue

        if item_type in {"compaction", "compaction_summary"}:
            records.append(
                input_context_record(
                    role="compaction",
                    text=provider_input_item_text(item),
                    provider_items=[item],
                )
            )
            continue

        records.append(
            input_context_record(
                role="context",
                text=provider_input_item_text(item),
                provider_items=[item],
            )
        )

    flush_assistant_items()
    return records


def build_provider_items_for_record(
    *,
    role: str,
    text: str,
    attachments: list[dict[str, object]],
    tool_events: list[dict[str, object]],
    blocks: list[dict[str, object]],
    record_index: int,
) -> list[dict[str, Any]]:
    safe_role = sanitize_text(role).strip()
    if safe_role == "user":
        return [
            SessionAgent._message(
                "user",
                sanitize_text(text),
                attachments=attachment_inputs_from_records(attachments),
            )
        ]

    if safe_role != "assistant":
        return []

    effective_tool_events = tool_events or extract_tool_events_from_blocks(blocks)
    provider_items: list[dict[str, Any]] = []
    text_buffer: list[str] = []
    saw_tool = False
    next_tool_index = 1

    for block in blocks:
        kind = sanitize_text(block.get("kind") or "").strip()
        if kind == "text":
            block_text = sanitize_text(block.get("text") or "")
            if block_text:
                text_buffer.append(block_text)
            continue

        if kind != "tool":
            continue

        saw_tool = True
        flush_assistant_text_buffer(provider_items, text_buffer)

        raw_tool_event = block.get("tool_event")
        if isinstance(raw_tool_event, dict):
            append_tool_provider_items(
                provider_items,
                tool_event=raw_tool_event,
                record_index=record_index,
                tool_index=next_tool_index,
            )
            next_tool_index += 1
            continue

        if next_tool_index - 1 < len(effective_tool_events):
            append_tool_provider_items(
                provider_items,
                tool_event=effective_tool_events[next_tool_index - 1],
                record_index=record_index,
                tool_index=next_tool_index,
            )
            next_tool_index += 1

    while next_tool_index - 1 < len(effective_tool_events):
        saw_tool = True
        append_tool_provider_items(
            provider_items,
            tool_event=effective_tool_events[next_tool_index - 1],
            record_index=record_index,
            tool_index=next_tool_index,
        )
        next_tool_index += 1

    flush_assistant_text_buffer(provider_items, text_buffer)

    if not provider_items:
        provider_items.append(
            SessionAgent._message(
                "assistant",
                sanitize_text(text),
            )
        )
    elif provider_items[-1].get("type") != "message":
        fallback_text = sanitize_text(text or "")
        provider_items.append(
            SessionAgent._message(
                "assistant",
                fallback_text,
            )
        )
    elif saw_tool:
        last_item_content = provider_items[-1].get("content")
        if not sanitize_text(last_item_content or "").strip():
            provider_items[-1] = SessionAgent._message(
                "assistant",
                sanitize_text(text or ""),
            )

    return normalize_provider_items(provider_items)


def message_blocks_to_text(blocks: list[dict[str, object]]) -> str:
    text_parts: list[str] = []
    for block in blocks:
        if sanitize_text(block.get("kind") or "").strip() != "text":
            continue
        text = sanitize_text(block.get("text") or "")
        if text:
            text_parts.append(text)

    return "".join(text_parts)


def message_blocks_have_reasoning(blocks: list[dict[str, object]]) -> bool:
    return any(sanitize_text(block.get("kind") or "").strip() == "reasoning" for block in blocks)


def normalize_transcript(raw_records: Any) -> list[dict[str, object]]:
    if not isinstance(raw_records, list):
        return []

    records: list[dict[str, object]] = []
    for record_index, item in enumerate(raw_records):
        if not isinstance(item, dict):
            continue
        role = sanitize_text(item.get("role") or "").strip()
        if role not in {"user", "assistant"}:
            continue
        tool_events = item.get("toolEvents")
        attachments = item.get("attachments")
        normalized_attachments = normalize_attachment_records(attachments)
        normalized_provider_items = normalize_provider_items(item.get("providerItems"))
        recovered_record = (
            compile_record_from_provider_items(
                {
                    "role": role,
                    "attachments": normalized_attachments,
                },
                normalized_provider_items,
            )
            if normalized_provider_items
            else None
        )

        safe_text = sanitize_text(item.get("text") or "")
        safe_tool_events = sanitize_value(tool_events) if isinstance(tool_events, list) else []
        blocks = normalize_message_blocks(item.get("blocks"))
        if not blocks and isinstance(recovered_record, dict):
            blocks = normalize_message_blocks(recovered_record.get("blocks"))

        if not safe_text and isinstance(recovered_record, dict):
            safe_text = sanitize_text(recovered_record.get("text") or "")

        if role == "assistant" and not safe_tool_events and isinstance(recovered_record, dict):
            recovered_tool_events = recovered_record.get("toolEvents")
            if isinstance(recovered_tool_events, list):
                safe_tool_events = sanitize_value(recovered_tool_events)

        if not blocks:
            blocks = blocks_from_text_and_tools(
                role,
                safe_text,
                safe_tool_events,
            )
        if role == "assistant" and not safe_tool_events:
            safe_tool_events = extract_tool_events_from_blocks(blocks)
        if not safe_text:
            safe_text = message_blocks_to_text(blocks)

        provider_items = normalized_provider_items or build_provider_items_for_record(
            role=role,
            text=safe_text,
            attachments=normalized_attachments,
            tool_events=safe_tool_events,
            blocks=blocks,
            record_index=record_index,
        )
        records.append(
            {
                "role": role,
                "text": safe_text,
                "attachments": normalized_attachments,
                "toolEvents": safe_tool_events,
                "blocks": blocks,
                "providerItems": provider_items,
            }
        )
    return records


def block_text_preview(text: str, limit: int = 280) -> str:
    compact = " ".join(sanitize_text(text).split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: max(0, limit - 3)]}..."


def extract_text_from_provider_message_content(content: Any) -> str:
    if isinstance(content, str):
        return sanitize_text(content)

    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            text = sanitize_text(item)
            if text:
                parts.append(text)
            continue

        if not isinstance(item, dict):
            continue

        text = sanitize_text(item.get("text") or item.get("content") or "")
        if text:
            parts.append(text)

    return "".join(parts)


def replace_provider_message_text(content: Any, replacement_text: str) -> str | list[dict[str, Any]]:
    safe_text = sanitize_text(replacement_text)
    if isinstance(content, list):
        rewritten: list[dict[str, Any]] = []
        text_item_type = "input_text"
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = sanitize_text(item.get("type") or "").strip()
            if item_type in {"input_text", "output_text", "text"} or "text" in item:
                if item_type == "output_text":
                    text_item_type = "output_text"
                continue
            rewritten.append(sanitize_value(item))

        if safe_text:
            rewritten.insert(
                0,
                {
                    "type": text_item_type,
                    "text": safe_text,
                },
            )
        return rewritten

    return safe_text


def provider_item_detail(item: dict[str, Any], item_number: int) -> dict[str, object]:
    item_type = sanitize_text(item.get("type") or "").strip() or "unknown"
    detail: dict[str, object] = {
        "item_number": item_number,
        "item_label": f"item #{item_number}",
        "item_type": item_type,
        "type": item_type,
        "provider_item_ref": f"provider_items[{item_number - 1}]",
        "delete_supported": True,
        "replace_supported": item_type in {"message", "function_call", "function_call_output"},
        "compress_supported": item_type in {"message", "function_call", "function_call_output"},
    }

    if item_type == "message":
        content = item.get("content")
        detail["role"] = sanitize_text(item.get("role") or "").strip() or "assistant"
        text = extract_text_from_provider_message_content(content)
        detail["text_preview"] = block_text_preview(text, limit=220)
        detail["editable_text_ref"] = f"provider_items[{item_number - 1}].content"
        preview_source = (
            json.dumps(sanitize_value(content), ensure_ascii=False)
            if isinstance(content, list)
            else sanitize_text(content or "")
        )
        detail["preview"] = block_text_preview(preview_source, limit=180)
        return detail

    if item_type == "function_call":
        detail["name"] = sanitize_text(item.get("name") or "").strip() or "tool"
        detail["call_id"] = sanitize_text(item.get("call_id") or "").strip()
        arguments = sanitize_text(item.get("arguments") or "{}") or "{}"
        detail["arguments_preview"] = block_text_preview(arguments, limit=220)
        detail["editable_text_ref"] = f"provider_items[{item_number - 1}].arguments"
        detail["preview"] = block_text_preview(arguments, limit=180)
        return detail

    if item_type == "function_call_output":
        detail["call_id"] = sanitize_text(item.get("call_id") or "").strip()
        output = sanitize_text(item.get("output") or "")
        detail["output_preview"] = block_text_preview(output, limit=220)
        detail["editable_text_ref"] = f"provider_items[{item_number - 1}].output"
        detail["preview"] = block_text_preview(output, limit=180)
        return detail

    return detail


def build_tool_event_from_provider_items(
    function_call_item: dict[str, Any] | None,
    function_output_item: dict[str, Any] | None,
) -> dict[str, object]:
    call_name = sanitize_text((function_call_item or {}).get("name") or "").strip() or "tool"
    arguments_text = sanitize_text((function_call_item or {}).get("arguments") or "{}") or "{}"
    try:
        parsed_arguments = json.loads(arguments_text)
        safe_arguments = sanitize_value(parsed_arguments)
    except json.JSONDecodeError:
        safe_arguments = arguments_text

    output_text = sanitize_text((function_output_item or {}).get("output") or "")
    return {
        "name": call_name,
        "arguments": safe_arguments,
        "output_preview": block_text_preview(output_text, limit=180) if output_text else "",
        "raw_output": output_text,
        "display_title": call_name,
        "display_detail": block_text_preview(arguments_text, limit=160)
        if arguments_text.strip() not in {"", "{}", "[]"}
        else "",
        "display_result": block_text_preview(output_text, limit=180) if output_text else "",
        "status": "completed" if function_output_item is not None else "pending",
    }


def context_detail_block(block: dict[str, object], block_number: int) -> dict[str, object]:
    safe_block = sanitize_value(block)
    if sanitize_text(safe_block.get("kind") or "").strip() != "tool":
        return {
            "block_number": block_number,
            **safe_block,
        }

    tool_event = safe_block.get("tool_event")
    if not isinstance(tool_event, dict):
        return {
            "block_number": block_number,
            **safe_block,
        }

    slim_tool_event = {
        "name": sanitize_text(tool_event.get("name") or ""),
        "arguments": sanitize_value(tool_event.get("arguments")),
        "output_preview": sanitize_text(tool_event.get("output_preview") or ""),
        "display_title": sanitize_text(tool_event.get("display_title") or ""),
        "display_detail": sanitize_text(tool_event.get("display_detail") or ""),
        "display_result": sanitize_text(tool_event.get("display_result") or ""),
        "status": sanitize_text(tool_event.get("status") or ""),
    }
    return {
        "block_number": block_number,
        "kind": "tool",
        "tool_event": slim_tool_event,
        "full_output_source": "provider_items function_call_output with the same call_id",
    }


def compile_record_from_provider_items(
    original_record: dict[str, object],
    provider_items: list[dict[str, Any]],
) -> dict[str, object]:
    normalized_provider_items = normalize_provider_items(provider_items)
    role = sanitize_text(original_record.get("role") or "").strip() or "assistant"
    attachments = normalize_attachment_records(original_record.get("attachments"))

    blocks: list[dict[str, object]] = []
    tool_events: list[dict[str, object]] = []
    consumed_output_indexes: set[int] = set()
    output_indexes_by_call_id: dict[str, list[int]] = {}

    for index, item in enumerate(normalized_provider_items):
        if sanitize_text(item.get("type") or "").strip() != "function_call_output":
            continue
        call_id = sanitize_text(item.get("call_id") or "").strip()
        if not call_id:
            continue
        output_indexes_by_call_id.setdefault(call_id, []).append(index)

    for index, item in enumerate(normalized_provider_items):
        item_type = sanitize_text(item.get("type") or "").strip()
        if item_type == "message":
            message_text = extract_text_from_provider_message_content(item.get("content"))
            if message_text:
                blocks.append(
                    {
                        "kind": "text",
                        "text": message_text,
                    }
                )
            continue

        if item_type == "function_call":
            call_id = sanitize_text(item.get("call_id") or "").strip()
            output_item = None
            for output_index in output_indexes_by_call_id.get(call_id, []):
                if output_index in consumed_output_indexes:
                    continue
                output_item = normalized_provider_items[output_index]
                consumed_output_indexes.add(output_index)
                break

            tool_event = build_tool_event_from_provider_items(item, output_item)
            tool_events.append(tool_event)
            blocks.append(
                {
                    "kind": "tool",
                    "tool_event": tool_event,
                }
            )
            continue

        if item_type == "function_call_output" and index not in consumed_output_indexes:
            tool_event = build_tool_event_from_provider_items(None, item)
            tool_events.append(tool_event)
            blocks.append(
                {
                    "kind": "tool",
                    "tool_event": tool_event,
                }
            )

    return {
        "role": role,
        "text": message_blocks_to_text(blocks),
        "attachments": sanitize_value(attachments),
        "toolEvents": sanitize_value(tool_events),
        "blocks": sanitize_value(blocks),
        "providerItems": sanitize_value(normalized_provider_items),
    }


