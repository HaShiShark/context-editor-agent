from __future__ import annotations

import os
from pathlib import Path

from app_agent.session_agent import sanitize_text


REPO_ROOT = Path(__file__).resolve().parents[1]
REACT_DIST_DIR = REPO_ROOT / "react_app" / "dist"
RAW_STATE_DIR = Path(os.getenv("HASH_DATA_DIR", str(REPO_ROOT / "data"))).expanduser()
STATE_DIR = RAW_STATE_DIR if RAW_STATE_DIR.is_absolute() else (REPO_ROOT / RAW_STATE_DIR).resolve()
STATE_FILE = STATE_DIR / "hash_web_state.json"
STATE_DB_FILE = STATE_DIR / "hash_web_state.sqlite3"
CONTEXT_REQUEST_DEBUG_FILE = STATE_DIR / "context_request_debug.ndjson"
ATTACHMENTS_DIR = STATE_DIR / "uploads"
ATTACHMENTS_ROUTE = "uploads"


def is_relative_to_path(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def attachment_url_path(stored_name: str) -> str:
    return f"{ATTACHMENTS_ROUTE}/{stored_name}"


def resolve_attachment_file_path(relative_path: str) -> Path | None:
    safe_relative_path = sanitize_text(relative_path or "").replace("\\", "/").lstrip("/")
    if not safe_relative_path:
        return None

    route_prefix = f"{ATTACHMENTS_ROUTE}/"
    if safe_relative_path.startswith(route_prefix):
        attachment_name = safe_relative_path.removeprefix(route_prefix).strip("/")
        if not attachment_name or "/" in attachment_name:
            return None

        attachments_root = ATTACHMENTS_DIR.resolve()
        candidate = (ATTACHMENTS_DIR / attachment_name).resolve()
        return candidate if is_relative_to_path(candidate, attachments_root) else None

    repo_root = REPO_ROOT.resolve()
    candidate = (REPO_ROOT / safe_relative_path).resolve()
    return candidate if is_relative_to_path(candidate, repo_root) else None

