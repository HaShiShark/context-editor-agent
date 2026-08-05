from __future__ import annotations

import base64
import mimetypes
import re
import uuid
from pathlib import Path
from typing import Any

from app_agent.session_agent import sanitize_text

from .paths import ATTACHMENTS_DIR, attachment_url_path, resolve_attachment_file_path


MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024
DATA_URL_PATTERN = re.compile(r"^data:(?P<mime>[^;,]+);base64,(?P<data>.+)$")


def normalize_attachment_records(raw_attachments: Any) -> list[dict[str, object]]:
    if not isinstance(raw_attachments, list):
        return []

    normalized: list[dict[str, object]] = []
    for item in raw_attachments:
        if not isinstance(item, dict):
            continue

        name = sanitize_text(item.get("name") or "").strip()
        relative_path = sanitize_text(item.get("relative_path") or "").strip()
        mime_type = sanitize_text(item.get("mime_type") or "").strip()
        kind = sanitize_text(item.get("kind") or "").strip() or "file"
        attachment_id = sanitize_text(item.get("id") or "").strip()

        if not name or not relative_path:
            continue

        size_bytes = item.get("size_bytes")
        if not isinstance(size_bytes, int):
            try:
                size_bytes = int(size_bytes)
            except (TypeError, ValueError):
                size_bytes = 0

        normalized.append(
            {
                "id": attachment_id or uuid.uuid4().hex,
                "name": name,
                "mime_type": mime_type or "application/octet-stream",
                "kind": "image" if kind == "image" else "file",
                "size_bytes": max(0, size_bytes),
                "relative_path": relative_path,
                "url": f"/{relative_path}",
            }
        )

    return normalized


def parse_data_url(data_url: str) -> tuple[str, bytes]:
    match = DATA_URL_PATTERN.match(sanitize_text(data_url))
    if not match:
        raise ValueError("attachment data_url is invalid")

    mime_type = sanitize_text(match.group("mime") or "").strip() or "application/octet-stream"
    try:
        raw_bytes = base64.b64decode(match.group("data"), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("闄勪欢缂栫爜瑙ｆ瀽澶辫触") from exc

    if not raw_bytes:
        raise ValueError("闄勪欢鍐呭涓虹┖")

    return mime_type, raw_bytes


def build_attachment_input(name: str, mime_type: str, data_url: str) -> dict[str, Any]:
    safe_name = sanitize_text(name).strip() or "upload"
    safe_mime_type = sanitize_text(mime_type).strip() or "application/octet-stream"
    safe_data_url = sanitize_text(data_url)

    if safe_mime_type.startswith("image/"):
        return {
            "type": "input_image",
            "image_url": safe_data_url,
            "detail": "auto",
        }

    return {
        "type": "input_file",
        "filename": safe_name,
        "file_data": safe_data_url,
    }


def build_attachment_path_note(name: str, mime_type: str, file_path: Path) -> dict[str, str]:
    safe_name = sanitize_text(name).strip() or file_path.name
    safe_mime_type = sanitize_text(mime_type).strip() or "application/octet-stream"
    return {
        "type": "input_text",
        "text": (
            f"Attachment available locally: {safe_name}\n"
            f"MIME type: {safe_mime_type}\n"
            f"Local path for tools: {file_path}"
        ),
    }


def persist_request_attachments(raw_attachments: Any) -> tuple[list[dict[str, object]], list[dict[str, Any]]]:
    if raw_attachments in (None, ""):
        return [], []
    if not isinstance(raw_attachments, list):
        raise ValueError("attachments must be a list")

    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    transcript_attachments: list[dict[str, object]] = []
    agent_inputs: list[dict[str, Any]] = []
    total_size = 0

    for raw_item in raw_attachments:
        if not isinstance(raw_item, dict):
            continue

        original_name = sanitize_text(raw_item.get("name") or "").strip() or "upload"
        data_url = sanitize_text(raw_item.get("data_url") or "")
        payload_mime_type = sanitize_text(raw_item.get("mime_type") or "").strip()
        parsed_mime_type, raw_bytes = parse_data_url(data_url)
        mime_type = payload_mime_type or parsed_mime_type or "application/octet-stream"
        total_size += len(raw_bytes)

        if len(raw_bytes) > MAX_ATTACHMENT_BYTES:
            raise ValueError(f"闄勪欢 {original_name} 瓒呰繃 50 MB")
        if total_size > MAX_TOTAL_ATTACHMENT_BYTES:
            raise ValueError("鏈疆闄勪欢鎬诲ぇ灏忚秴杩?50 MB")

        suffix = Path(original_name).suffix
        if not suffix:
            guessed_extension = mimetypes.guess_extension(mime_type or "") or ""
            suffix = guessed_extension

        attachment_id = uuid.uuid4().hex
        stored_name = f"{attachment_id}{suffix}"
        stored_path = ATTACHMENTS_DIR / stored_name
        stored_path.write_bytes(raw_bytes)

        relative_path = attachment_url_path(stored_name)
        kind = "image" if mime_type.startswith("image/") else "file"

        transcript_attachments.append(
            {
                "id": attachment_id,
                "name": original_name,
                "mime_type": mime_type,
                "kind": kind,
                "size_bytes": len(raw_bytes),
                "relative_path": relative_path,
                "url": f"/{relative_path}",
            }
        )
        agent_inputs.append(build_attachment_path_note(original_name, mime_type, stored_path.resolve()))
        agent_inputs.append(build_attachment_input(original_name, mime_type, data_url))

    return transcript_attachments, agent_inputs


def attachment_inputs_from_records(attachments: list[dict[str, object]]) -> list[dict[str, Any]]:
    inputs: list[dict[str, Any]] = []
    for attachment in attachments:
        relative_path = sanitize_text(attachment.get("relative_path") or "").strip()
        name = sanitize_text(attachment.get("name") or "").strip()
        mime_type = sanitize_text(attachment.get("mime_type") or "").strip()
        if not relative_path:
            continue

        file_path = resolve_attachment_file_path(relative_path)
        if file_path is None or not file_path.exists() or not file_path.is_file():
            continue

        raw_bytes = file_path.read_bytes()
        if not raw_bytes:
            continue

        safe_mime_type = mime_type or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        data_url = f"data:{safe_mime_type};base64,{base64.b64encode(raw_bytes).decode('ascii')}"
        inputs.append(build_attachment_path_note(name or file_path.name, safe_mime_type, file_path))
        inputs.append(build_attachment_input(name or file_path.name, safe_mime_type, data_url))

    return inputs

