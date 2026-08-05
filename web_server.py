from __future__ import annotations

import json
import hashlib
import mimetypes
import os
import re
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv

try:
    import tiktoken
except ImportError:  # pragma: no cover - dependency fallback for partially installed environments
    tiktoken = None

from app_agent.session_agent import SessionAgent, ToolEvent, sanitize_text
from app_agent.settings import Settings, _UNSET, load_settings, save_settings
from app_agent.tools import ToolExecution
from web_server_modules.attachments import (
    DATA_URL_PATTERN,
    MAX_ATTACHMENT_BYTES,
    MAX_TOTAL_ATTACHMENT_BYTES,
    attachment_inputs_from_records,
    build_attachment_input,
    build_attachment_path_note,
    normalize_attachment_records,
    parse_data_url,
    persist_request_attachments,
)
from web_server_modules.paths import (
    ATTACHMENTS_DIR,
    ATTACHMENTS_ROUTE,
    CONTEXT_REQUEST_DEBUG_FILE,
    REACT_DIST_DIR,
    REPO_ROOT,
    STATE_DB_FILE,
    STATE_FILE,
    attachment_url_path,
    is_relative_to_path,
    resolve_attachment_file_path,
)
from web_server_modules.providers import (
    PROVIDER_MODEL_TYPES,
    active_provider_models,
    build_provider_models_url,
    build_provider_models_url_candidates,
    clone_provider_settings_payloads,
    fetch_models_from_provider,
    model_options,
    normalize_fetched_provider_models,
    normalize_provider_api_base_url,
    normalize_provider_type,
)
from web_server_modules.serialization import sanitize_value
from web_server_modules.state_store import SQLiteStateStore
from web_server_modules.transcript import (
    ThinkTagStreamParser,
    append_tool_provider_items,
    assistant_provider_items_from_history_slice,
    block_text_preview,
    blocks_from_text_and_tools,
    build_provider_items_for_record,
    build_tool_event_from_provider_items,
    compile_record_from_provider_items,
    context_detail_block,
    extract_text_from_provider_message_content,
    extract_tool_events_from_blocks,
    fallback_blocks_from_text_and_tools,
    flush_assistant_text_buffer,
    input_context_record,
    message_blocks_have_reasoning,
    message_blocks_to_text,
    normalize_message_blocks,
    normalize_provider_items,
    normalize_transcript,
    provider_input_item_text,
    provider_input_to_context_records,
    provider_item_detail,
    sanitize_provider_input_item,
)
from web_server_modules.usage import (
    add_provider_usage,
    normalize_usage_summary,
    usage_summary_payload,
)
from web_server_modules.context_workbench import (
    ContextWorkbenchDraft,
    ContextWorkbenchDraftNode,
    ContextWorkbenchToolDefinition,
    ContextWorkbenchToolRegistry,
    build_context_revision_entry,
    build_context_workspace_snapshot,
    coerce_context_revision_number,
    context_pending_restore_payload,
    context_record_overview,
    context_record_preview,
    context_revision_summaries,
    context_transcript_stats,
    ensure_initial_context_revision,
    estimate_token_count,
    fallback_context_revision_summary,
    find_active_context_revision_id,
    format_node_ranges,
    format_token_count,
    format_tool_usage,
    get_token_encoding,
    has_initial_context_revision,
    letter_index,
    mark_active_context_revision,
    next_context_revision_number,
    normalize_change_type,
    normalize_context_chat_history,
    normalize_context_revision_entries,
    normalize_node_numbers,
    normalize_pending_context_restore,
    normalize_selected_node_indexes,
    operation_change_type,
    operation_changed_nodes,
    prepare_context_chat_history_for_model,
    provider_items_tool_token_count,
    record_context_tool_weight_source,
    record_context_weight_source,
    record_tool_usage,
    summarize_change_type,
    summarize_changed_nodes_from_operations,
    sync_active_context_revision_snapshot,
    unique_int_list,
    unique_text_list,
    utc_timestamp,
)


DEFAULT_PROJECT_ID = "project_root"
NEW_PROJECT_PREFIX = "新项目"
NEW_SESSION_TITLE = "新对话"
HIDDEN_WORKSPACE_ENTRIES = {
    ".git",
    ".venv",
    "__pycache__",
    "node_modules",
    "tmp_cherry_extract",
}
_TOKEN_ENCODING: Any | None = None
_TOKEN_ENCODING_LOAD_FAILED = False


DEFAULT_REASONING_OPTIONS = [
    {"value": "default", "label": "自动"},
    {"value": "none", "label": "关闭"},
    {"value": "low", "label": "低"},
    {"value": "medium", "label": "中"},
    {"value": "high", "label": "高"},
]
TITLE_GENERATION_INSTRUCTIONS = "\n".join(
    [
        "你只负责给一段新对话起标题。",
        "标题要短、具体、自然，优先使用用户的语言。",
        "不要解释，不要加引号，不要使用 Markdown。",
        "最多 18 个中文字符或 8 个英文单词。",
    ]
)


class ClientDisconnectedError(BrokenPipeError):
    """Raised when the front-end intentionally closes a stream early."""


class RequestCancelledError(RuntimeError):
    """Raised when the user explicitly stops the active request."""


@dataclass(slots=True)
class SessionState:
    session_id: str
    title: str
    scope: str
    project_id: str | None
    agent: SessionAgent
    transcript: list[dict[str, object]]
    context_input: list[dict[str, object]]
    context_workbench_history: list[dict[str, str]]
    context_revisions: list[dict[str, object]]
    pending_context_restore: dict[str, object] | None
    pending_context_review: dict[str, object] | None
    usage_summary: dict[str, object]
    active_request_mode: str | None = None
    active_request_id: str | None = None
    active_cancel_event: threading.Event | None = None


@dataclass(slots=True)
class ProjectState:
    project_id: str
    title: str
    session_ids: list[str]
    root_path: str | None = None
    archived_session_ids: list[str] | None = None


def context_transcript_fingerprint(transcript: list[dict[str, object]]) -> str:
    canonical = json.dumps(
        sanitize_value(normalize_transcript(transcript)),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def normalize_pending_context_review(raw_review: Any) -> dict[str, object] | None:
    if not isinstance(raw_review, dict):
        return None
    review_id = sanitize_text(raw_review.get("id") or "").strip()
    base_fingerprint = sanitize_text(raw_review.get("base_context_fingerprint") or "").strip()
    proposed_transcript = normalize_transcript(raw_review.get("proposed_transcript"))
    if not review_id or not base_fingerprint or not proposed_transcript:
        return None
    operations = raw_review.get("operations")
    return {
        "id": review_id,
        "session_id": sanitize_text(raw_review.get("session_id") or "").strip(),
        "source": "auto_idle" if raw_review.get("source") == "auto_idle" else "manual",
        "created_at": sanitize_text(raw_review.get("created_at") or "").strip() or utc_timestamp(),
        "summary": sanitize_text(raw_review.get("summary") or "").strip(),
        "model": sanitize_text(raw_review.get("model") or "").strip(),
        "base_context_fingerprint": base_fingerprint,
        "before": sanitize_value(raw_review.get("before") or {}),
        "after": sanitize_value(raw_review.get("after") or {}),
        "proposed_transcript": sanitize_value(proposed_transcript),
        "operations": sanitize_value(operations if isinstance(operations, list) else []),
    }


def pending_context_review_payload(raw_review: Any) -> dict[str, object] | None:
    review = normalize_pending_context_review(raw_review)
    return sanitize_value(review) if review is not None else None


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self._request_condition = threading.Condition(self.lock)
        self.projects: list[ProjectState] = []
        self.chat_session_ids: list[str] = []
        self.sessions: dict[str, SessionState] = {}
        self._context_review_timer_lock = threading.Lock()
        self._context_review_timers: dict[str, threading.Timer] = {}
        self._auto_review_request_ids: set[str] = set()
        self.state_store = SQLiteStateStore(STATE_DB_FILE, legacy_json_file=STATE_FILE)
        self._load_state()

    def refresh_settings(self, settings: Settings) -> None:
        with self._context_review_timer_lock:
            scheduled_session_ids = list(self._context_review_timers)
        with self.lock:
            self.settings = settings
            for session in self.sessions.values():
                session.agent = SessionAgent(self._settings_for_session_locked(session))
                self._hydrate_agent_locked(session)
            self._save_state_locked()
        for session_id in scheduled_session_ids:
            self.cancel_scheduled_context_review(session_id)
        if settings.context_review_auto_enabled:
            for session_id in scheduled_session_ids:
                try:
                    session = self.get_session(session_id)
                except ValueError:
                    continue
                with self.lock:
                    should_reschedule = (
                        session.pending_context_review is None
                        and len(normalize_transcript(session.transcript)) >= 2
                    )
                if should_reschedule:
                    self.schedule_context_review(session)

    def create_project(self, title: str | None = None, root_path: str | None = None) -> ProjectState:
        with self.lock:
            normalized_root_path = self._coerce_project_root_path(root_path)
            project = ProjectState(
                project_id=uuid.uuid4().hex,
                title=self._coerce_project_title(title, normalized_root_path),
                session_ids=[],
                root_path=normalized_root_path,
                archived_session_ids=[],
            )
            self.projects.insert(0, project)
            self._save_state_locked()
            return project

    def pin_project(self, project_id: str | None) -> ProjectState:
        safe_project_id = sanitize_text(project_id or "").strip()
        if not safe_project_id:
            raise ValueError("project_id is required")

        with self.lock:
            project = self._find_project_locked(safe_project_id)
            if project is None:
                raise ValueError("project not found")
            self.projects = [item for item in self.projects if item.project_id != safe_project_id]
            self.projects.insert(0, project)
            self._save_state_locked()
            return project

    def rename_project(self, project_id: str | None, title: str | None) -> ProjectState:
        safe_project_id = sanitize_text(project_id or "").strip()
        safe_title = sanitize_text(title or "").strip()
        if not safe_project_id:
            raise ValueError("project_id is required")
        if not safe_title:
            raise ValueError("project title is required")

        with self.lock:
            project = self._find_project_locked(safe_project_id)
            if project is None:
                raise ValueError("project not found")
            project.title = safe_title
            self._save_state_locked()
            return project

    def archive_project_sessions(self, project_id: str | None) -> tuple[ProjectState, list[str]]:
        safe_project_id = sanitize_text(project_id or "").strip()
        if not safe_project_id:
            raise ValueError("project_id is required")

        with self.lock:
            project = self._find_project_locked(safe_project_id)
            if project is None:
                raise ValueError("project not found")
            archived_session_ids = list(project.session_ids)
            existing_archived_ids = list(project.archived_session_ids or [])
            for session_id in archived_session_ids:
                if session_id not in existing_archived_ids:
                    existing_archived_ids.insert(0, session_id)
            project.session_ids = []
            project.archived_session_ids = existing_archived_ids
            self._save_state_locked()
            return project, archived_session_ids

    def create_session(
        self,
        *,
        scope: str = "chat",
        project_id: str | None = None,
    ) -> SessionState:
        normalized_scope = self._normalize_scope(scope)

        with self.lock:
            target_project_id: str | None = None
            if normalized_scope == "project":
                project = self._find_project_locked(project_id) or self._ensure_default_project_locked()
                target_project_id = project.project_id
            new_session_id = uuid.uuid4().hex
            session = SessionState(
                session_id=new_session_id,
                title=NEW_SESSION_TITLE,
                scope=normalized_scope,
                project_id=target_project_id,
                agent=SessionAgent(self._settings_for_project_locked(target_project_id)),
                transcript=[],
                context_input=[],
                context_workbench_history=[],
                context_revisions=[],
                pending_context_restore=None,
                pending_context_review=None,
                usage_summary=normalize_usage_summary({}, new_session_id),
            )
            session.context_input = provider_input_to_context_records(session.agent.request_input_snapshot())
            ensure_initial_context_revision(session)
            self.sessions[session.session_id] = session
            self._insert_session_locked(session)
            self._save_state_locked()
            return session

    def get_session(self, session_id: str | None) -> SessionState:
        safe_session_id = sanitize_text(session_id or "").strip()
        if not safe_session_id:
            raise ValueError("session_id is required")

        with self.lock:
            session = self.sessions.get(safe_session_id)
            if session is None:
                raise ValueError("session not found")
            return session

    def acquire_session_request(
        self,
        session: SessionState,
        mode: str,
        *,
        auto_context_review: bool = False,
    ) -> str:
        safe_mode = sanitize_text(mode).strip()
        if safe_mode not in {"main", "context"}:
            raise ValueError("invalid session request mode")
        if auto_context_review and safe_mode != "context":
            raise ValueError("automatic review must use context request mode")

        with self._request_condition:
            active_mode = sanitize_text(session.active_request_mode or "").strip()
            active_cancelled = bool(session.active_cancel_event and session.active_cancel_event.is_set())
            active_is_auto_review = bool(
                session.active_request_id
                and session.active_request_id in self._auto_review_request_ids
            )
            if active_mode and active_cancelled and active_is_auto_review:
                self._request_condition.wait_for(
                    lambda: session.active_request_mode is None,
                    timeout=30,
                )
                active_mode = sanitize_text(session.active_request_mode or "").strip()
                active_cancelled = bool(session.active_cancel_event and session.active_cancel_event.is_set())
            if active_mode and active_mode != safe_mode:
                raise ValueError("当前主聊天和上下文工作区不能并行，请等这一轮先结束。")
            if active_mode == safe_mode:
                if safe_mode == "main":
                    raise ValueError("当前这条主对话还没有结束。")
                raise ValueError("当前上下文工作区还在处理中。")
            request_id = uuid.uuid4().hex
            session.active_request_mode = safe_mode
            session.active_request_id = request_id
            session.active_cancel_event = threading.Event()
            if auto_context_review:
                self._auto_review_request_ids.add(request_id)
            return request_id

    def release_session_request(self, session: SessionState, mode: str, request_id: str | None = None) -> None:
        safe_mode = sanitize_text(mode).strip()
        if safe_mode not in {"main", "context"}:
            return

        with self._request_condition:
            if request_id is not None and session.active_request_id != request_id:
                return
            if session.active_request_mode == safe_mode:
                released_request_id = session.active_request_id
                session.active_request_mode = None
                session.active_request_id = None
                session.active_cancel_event = None
                if released_request_id:
                    self._auto_review_request_ids.discard(released_request_id)
                self._request_condition.notify_all()

    def cancel_session_request(self, session: SessionState, mode: str) -> bool:
        safe_mode = sanitize_text(mode).strip()
        if safe_mode not in {"main", "context"}:
            raise ValueError("invalid session request mode")

        with self.lock:
            if session.active_request_mode != safe_mode or session.active_cancel_event is None:
                return False
            session.active_cancel_event.set()
            return True

    def is_session_request_cancelled(self, session: SessionState, request_id: str) -> bool:
        with self.lock:
            if session.active_request_id != request_id:
                return True
            return bool(session.active_cancel_event and session.active_cancel_event.is_set())

    def cancel_auto_context_review(self, session: SessionState) -> bool:
        with self.lock:
            request_id = sanitize_text(session.active_request_id or "").strip()
            if (
                session.active_request_mode != "context"
                or request_id not in self._auto_review_request_ids
                or session.active_cancel_event is None
            ):
                return False
            session.active_cancel_event.set()
            return True

    def prepare_interactive_request(self, session: SessionState) -> None:
        """Give an explicit user action priority over scheduled context review work."""
        self.cancel_scheduled_context_review(session.session_id)
        self.cancel_auto_context_review(session)

    def touch_session(self, session_id: str) -> None:
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                return
            self._remove_session_from_lists_locked(session_id)
            self._insert_session_locked(session)
            self._save_state_locked()

    def reset_session(self, session_id: str) -> SessionState:
        session = self.get_session(session_id)
        self.cancel_scheduled_context_review(session.session_id)
        self.cancel_auto_context_review(session)
        with self.lock:
            session.agent.reset()
            session.title = NEW_SESSION_TITLE
            session.transcript = []
            session.context_workbench_history = []
            session.context_revisions = []
            session.pending_context_restore = None
            session.pending_context_review = None
            session.usage_summary = normalize_usage_summary({}, session.session_id)
            ensure_initial_context_revision(session)
            self._save_state_locked()
        return session

    def truncate_session(self, session_id: str, from_index: int) -> SessionState:
        session = self.get_session(session_id)
        self.cancel_scheduled_context_review(session.session_id)
        self.cancel_auto_context_review(session)
        with self.lock:
            safe_index = max(0, min(from_index, len(session.transcript)))
            session.transcript = session.transcript[:safe_index]
            session.context_workbench_history = []
            session.context_revisions = []
            session.pending_context_restore = None
            session.pending_context_review = None
            ensure_initial_context_revision(session)
            self._hydrate_agent_locked(session)
            if not session.transcript:
                session.title = NEW_SESSION_TITLE
            self._save_state_locked()
        return session

    def delete_transcript_message(
        self,
        session_id: str,
        message_index: int,
    ) -> SessionState:
        session = self.get_session(session_id)
        self.cancel_scheduled_context_review(session.session_id)
        with self.lock:
            normalized_transcript = normalize_transcript(session.transcript)
            if not normalized_transcript:
                raise ValueError("褰撳墠娌℃湁鍙垹闄ょ殑娑堟伅")

            safe_index = int(message_index)
            if safe_index < 0 or safe_index >= len(normalized_transcript):
                raise ValueError("message_index is out of range")

            session.transcript = [
                record
                for index, record in enumerate(normalized_transcript)
                if index != safe_index
            ]
            session.pending_context_review = None
            ensure_initial_context_revision(session)
            sync_active_context_revision_snapshot(session)
            self._hydrate_agent_locked(session)
            if not session.transcript:
                session.title = NEW_SESSION_TITLE
            self._save_state_locked()
        return session

    def delete_session(self, session_id: str) -> SessionState:
        session = self.get_session(session_id)
        self.cancel_scheduled_context_review(session.session_id)
        self.cancel_auto_context_review(session)
        with self.lock:
            self.sessions.pop(session.session_id, None)
            self._remove_session_from_lists_locked(session.session_id)
            self._save_state_locked()
        return session

    def delete_project(self, project_id: str | None) -> tuple[ProjectState, list[str]]:
        safe_project_id = sanitize_text(project_id or "").strip()
        if not safe_project_id:
            raise ValueError("project_id is required")

        with self.lock:
            project_index = next(
                (index for index, project in enumerate(self.projects) if project.project_id == safe_project_id),
                None,
            )
            if project_index is None:
                raise ValueError("project not found")

            project = self.projects.pop(project_index)
            deleted_session_ids = list(project.session_ids)
            for session_id in deleted_session_ids:
                session = self.sessions.pop(session_id, None)
                if (
                    session is not None
                    and session.active_request_id in self._auto_review_request_ids
                    and session.active_cancel_event is not None
                ):
                    session.active_cancel_event.set()

            self._save_state_locked()
        for session_id in deleted_session_ids:
            self.cancel_scheduled_context_review(session_id)
        return project, deleted_session_ids

    def rename_session_from_message(self, session: SessionState, message: str) -> None:
        compact = summarize_title(message)
        with self.lock:
            if session.title == NEW_SESSION_TITLE and compact:
                session.title = compact
                self._save_state_locked()

    def should_name_session_from_first_message(self, session: SessionState) -> bool:
        with self.lock:
            return session.title == NEW_SESSION_TITLE and not normalize_transcript(session.transcript)

    def name_session_from_first_message(
        self,
        session: SessionState,
        message: str,
        *,
        model: str | None = None,
    ) -> None:
        safe_message = sanitize_text(message).strip()
        if not safe_message:
            return

        with self.lock:
            if session.title != NEW_SESSION_TITLE or normalize_transcript(session.transcript):
                return

        title = generate_session_title(
            self.settings,
            safe_message,
            model=model,
        )
        if not title:
            return

        with self.lock:
            if session.title == NEW_SESSION_TITLE and not normalize_transcript(session.transcript):
                session.title = title
                self._save_state_locked()

    def name_session_from_first_message_async(
        self,
        session: SessionState,
        message: str,
        *,
        model: str | None = None,
    ) -> None:
        safe_message = sanitize_text(message).strip()
        if not safe_message:
            return

        fallback_title = summarize_title(safe_message)
        if not fallback_title:
            return

        with self.lock:
            if session.title != NEW_SESSION_TITLE or normalize_transcript(session.transcript):
                return

            session.title = fallback_title
            session_id = session.session_id
            self._save_state_locked()

        def worker() -> None:
            title = generate_session_title(
                self.settings,
                safe_message,
                model=model,
            )
            if not title or title == fallback_title:
                return

            with self.lock:
                target_session = self.sessions.get(session_id)
                if target_session is None or target_session.title != fallback_title:
                    return

                target_session.title = title
                self._save_state_locked()

        threading.Thread(
            target=worker,
            name=f"hash-title-{session_id}",
            daemon=True,
        ).start()

    def append_context_workbench_turn(
        self,
        session: SessionState,
        *,
        user_message: str,
        answer: str,
    ) -> list[dict[str, str]]:
        with self.lock:
            session.pending_context_restore = None
            session.context_workbench_history = normalize_context_chat_history(
                [
                    *session.context_workbench_history,
                    {"role": "user", "content": sanitize_text(user_message)},
                    {"role": "assistant", "content": sanitize_text(answer)},
                ]
            )
            ensure_initial_context_revision(session)
            sync_active_context_revision_snapshot(session)
            self._save_state_locked()
            return sanitize_value(session.context_workbench_history)

    def delete_context_workbench_history_message(
        self,
        session: SessionState,
        *,
        message_index: int,
    ) -> tuple[list[dict[str, object]], list[dict[str, str]], list[dict[str, object]], dict[str, object] | None]:
        with self.lock:
            normalized_history = normalize_context_chat_history(session.context_workbench_history)
            if not normalized_history:
                raise ValueError("褰撳墠娌℃湁鍙垹闄ょ殑鎵嬪姩娑堟伅")

            safe_index = int(message_index)
            if safe_index < 0 or safe_index >= len(normalized_history):
                raise ValueError("message_index is out of range")

            session.context_workbench_history = [
                item
                for index, item in enumerate(normalized_history)
                if index != safe_index
            ]
            session.pending_context_restore = None
            sync_active_context_revision_snapshot(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                sanitize_value(session.context_workbench_history),
                context_revision_summaries(session.context_revisions),
                None,
            )

    def clear_context_workbench_history(
        self,
        session: SessionState,
    ) -> tuple[list[dict[str, object]], list[dict[str, str]], list[dict[str, object]], dict[str, object] | None]:
        with self.lock:
            session.context_workbench_history = []
            session.pending_context_restore = None
            sync_active_context_revision_snapshot(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                [],
                context_revision_summaries(session.context_revisions),
                None,
            )

    def apply_context_workbench_mutation(
        self,
        session: SessionState,
        *,
        transcript: list[dict[str, object]],
        revision_label: str,
        revision_summary: str,
        operations: list[dict[str, object]],
    ) -> tuple[list[dict[str, object]], list[dict[str, object]], dict[str, object] | None]:
        self.cancel_scheduled_context_review(session.session_id)
        with self.lock:
            ensure_initial_context_revision(session)
            next_revision_number = next_context_revision_number(session.context_revisions)
            session.transcript = normalize_transcript(transcript)
            session.pending_context_restore = None
            session.pending_context_review = None
            mark_active_context_revision(session.context_revisions, None)
            session.context_revisions.append(
                build_context_revision_entry(
                    transcript=session.transcript,
                    context_workbench_history=session.context_workbench_history,
                    revision_label=revision_label,
                    revision_summary=revision_summary,
                    operations=operations,
                    revision_number=next_revision_number,
                )
            )
            self._hydrate_agent_locked(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                context_revision_summaries(session.context_revisions),
                None,
            )

    def restore_context_revision(
        self,
        session: SessionState,
        revision_id: str,
    ) -> tuple[list[dict[str, object]], list[dict[str, str]], list[dict[str, object]], dict[str, object]]:
        self.cancel_scheduled_context_review(session.session_id)
        with self.lock:
            safe_revision_id = sanitize_text(revision_id).strip()
            target = next(
                (
                    revision
                    for revision in reversed(session.context_revisions)
                    if sanitize_text(revision.get("id") or "").strip() == safe_revision_id
                ),
                None,
            )
            if target is None:
                raise ValueError("revision not found")

            raw_snapshot = target.get("snapshot")
            snapshot = normalize_transcript(raw_snapshot)
            if not snapshot and session.transcript and "snapshot" not in target:
                raise ValueError("target revision snapshot is unavailable")
            workbench_history_snapshot = normalize_context_chat_history(
                target.get("context_workbench_history_snapshot")
            )

            undo_active_revision_id = find_active_context_revision_id(session.context_revisions)
            session.pending_context_restore = {
                "undo_transcript": sanitize_value(session.transcript),
                "undo_context_workbench_history": sanitize_value(session.context_workbench_history),
                "target_revision_id": safe_revision_id,
                "target_label": sanitize_text(target.get("label") or "").strip() or "Revision",
                "created_at": utc_timestamp(),
                "undo_active_revision_id": undo_active_revision_id or "",
            }
            session.transcript = snapshot
            session.context_workbench_history = workbench_history_snapshot
            session.pending_context_review = None
            mark_active_context_revision(session.context_revisions, safe_revision_id)
            sync_active_context_revision_snapshot(session)
            self._hydrate_agent_locked(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                sanitize_value(session.context_workbench_history),
                context_revision_summaries(session.context_revisions),
                context_pending_restore_payload(session.pending_context_restore),
            )

    def undo_context_restore(
        self,
        session: SessionState,
    ) -> tuple[list[dict[str, object]], list[dict[str, str]], list[dict[str, object]], dict[str, object] | None]:
        self.cancel_scheduled_context_review(session.session_id)
        with self.lock:
            pending_restore = session.pending_context_restore
            if not isinstance(pending_restore, dict):
                raise ValueError("there is no context restore to undo")

            undo_transcript = normalize_transcript(pending_restore.get("undo_transcript"))
            undo_context_workbench_history = normalize_context_chat_history(
                pending_restore.get("undo_context_workbench_history")
            )
            undo_active_revision_id = sanitize_text(pending_restore.get("undo_active_revision_id") or "").strip()
            session.transcript = undo_transcript
            session.context_workbench_history = undo_context_workbench_history
            session.pending_context_restore = None
            session.pending_context_review = None
            mark_active_context_revision(session.context_revisions, undo_active_revision_id or None)
            sync_active_context_revision_snapshot(session)
            self._hydrate_agent_locked(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                sanitize_value(session.context_workbench_history),
                context_revision_summaries(session.context_revisions),
                None,
            )

    def context_review_payload(self, session: SessionState) -> dict[str, object] | None:
        with self.lock:
            return pending_context_review_payload(session.pending_context_review)

    def session_usage_payload(self, session: SessionState) -> dict[str, object]:
        with self.lock:
            return usage_summary_payload(session.usage_summary, session.session_id)

    def record_usage_records(
        self,
        session: SessionState,
        kind: str,
        records: list[dict[str, Any]],
    ) -> dict[str, object]:
        if not records:
            return self.session_usage_payload(session)
        with self.lock:
            if self.sessions.get(session.session_id) is not session:
                return usage_summary_payload(session.usage_summary, session.session_id)
            summary: dict[str, object] = normalize_usage_summary(
                session.usage_summary,
                session.session_id,
            )
            for record in records:
                if not isinstance(record, dict):
                    continue
                summary = add_provider_usage(
                    summary,
                    session_id=session.session_id,
                    kind=kind,
                    model=sanitize_text(record.get("model") or "").strip(),
                    raw_usage=record.get("usage"),
                )
            session.usage_summary = summary
            self._save_state_locked()
            return usage_summary_payload(summary, session.session_id)

    def record_agent_usage(self, session: SessionState, kind: str = "main") -> dict[str, object]:
        pop_records = getattr(session.agent, "pop_usage_records", None)
        records = pop_records() if callable(pop_records) else []
        return self.record_usage_records(session, kind, records)

    def reset_session_usage(self, session: SessionState) -> dict[str, object]:
        with self.lock:
            session.usage_summary = normalize_usage_summary({}, session.session_id)
            self._save_state_locked()
            return usage_summary_payload(session.usage_summary, session.session_id)

    def discard_context_review(
        self,
        session: SessionState,
        review_id: str | None = None,
    ) -> None:
        safe_review_id = sanitize_text(review_id or "").strip()
        with self.lock:
            current = normalize_pending_context_review(session.pending_context_review)
            if safe_review_id and current is not None and current["id"] != safe_review_id:
                raise ValueError("context review not found")
            if session.pending_context_review is None:
                return
            session.pending_context_review = None
            self._save_state_locked()

    def store_context_review(
        self,
        session: SessionState,
        review: dict[str, object],
    ) -> dict[str, object]:
        normalized = normalize_pending_context_review(review)
        if normalized is None:
            raise ValueError("context review is invalid")
        with self.lock:
            if context_transcript_fingerprint(session.transcript) != normalized["base_context_fingerprint"]:
                raise ValueError("context changed while the suggestion was being generated")
            session.pending_context_review = normalized
            self._save_state_locked()
            return sanitize_value(normalized)

    def apply_context_review(
        self,
        session: SessionState,
        review_id: str,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]], dict[str, object] | None]:
        safe_review_id = sanitize_text(review_id).strip()
        self.cancel_scheduled_context_review(session.session_id)
        with self.lock:
            review = normalize_pending_context_review(session.pending_context_review)
            if review is None or review["id"] != safe_review_id:
                raise ValueError("context review not found")
            if context_transcript_fingerprint(session.transcript) != review["base_context_fingerprint"]:
                session.pending_context_review = None
                self._save_state_locked()
                raise ValueError("这条建议已经过期，因为当前上下文发生了变化。请重新分析。")

            proposed_transcript = normalize_transcript(review["proposed_transcript"])
            if not proposed_transcript:
                raise ValueError("context review transcript is unavailable")
            ensure_initial_context_revision(session)
            revision_number = next_context_revision_number(session.context_revisions)
            session.transcript = proposed_transcript
            session.pending_context_restore = None
            session.pending_context_review = None
            mark_active_context_revision(session.context_revisions, None)
            session.context_revisions.append(
                build_context_revision_entry(
                    transcript=session.transcript,
                    context_workbench_history=session.context_workbench_history,
                    revision_label="应用上下文建议",
                    revision_summary=sanitize_text(review.get("summary") or "").strip()
                    or "应用了上下文模型的整理建议。",
                    operations=review.get("operations") if isinstance(review.get("operations"), list) else [],
                    revision_number=revision_number,
                )
            )
            self._hydrate_agent_locked(session)
            self._save_state_locked()
            return (
                sanitize_value(session.transcript),
                context_revision_summaries(session.context_revisions),
                None,
            )

    def cancel_scheduled_context_review(self, session_id: str) -> None:
        with self._context_review_timer_lock:
            timer = self._context_review_timers.pop(session_id, None)
        if timer is not None:
            timer.cancel()

    def schedule_context_review(self, session: SessionState, *, delay_seconds: float | None = None) -> None:
        self.cancel_scheduled_context_review(session.session_id)
        if not self.settings.context_review_auto_enabled:
            return
        delay = (
            max(1.0, float(delay_seconds))
            if delay_seconds is not None
            else max(1.0, float(self.settings.context_review_interval_minutes) * 60.0)
        )
        timer = threading.Timer(delay, self._run_scheduled_context_review, args=(session.session_id,))
        timer.daemon = True
        timer.name = f"hash-context-review-{session.session_id[:8]}"
        with self._context_review_timer_lock:
            self._context_review_timers[session.session_id] = timer
        timer.start()

    def _run_scheduled_context_review(self, session_id: str) -> None:
        with self._context_review_timer_lock:
            self._context_review_timers.pop(session_id, None)
        if not self.settings.context_review_auto_enabled:
            return
        try:
            session = self.get_session(session_id)
        except ValueError:
            return
        with self.lock:
            if session.pending_context_review is not None or len(session.transcript) < 2:
                return
        try:
            request_id = self.acquire_session_request(
                session,
                "context",
                auto_context_review=True,
            )
        except ValueError:
            self.schedule_context_review(session, delay_seconds=30)
            return
        try:
            def check_cancelled() -> None:
                if self.is_session_request_cancelled(session, request_id):
                    raise RequestCancelledError()

            generate_context_review(
                self,
                session,
                source="auto_idle",
                check_cancelled=check_cancelled,
            )
        except RequestCancelledError:
            pass
        except Exception as exc:  # noqa: BLE001
            print(f"context review generation error: {type(exc).__name__}: {exc}")
        finally:
            self.release_session_request(session, "context", request_id)

    def append_turn(
        self,
        session: SessionState,
        *,
        user_message: str,
        answer: str,
        tool_events: list[ToolEvent],
        assistant_blocks: list[dict[str, object]] | None = None,
        assistant_provider_items: list[dict[str, Any]] | None = None,
        user_attachments: list[dict[str, object]] | None = None,
    ) -> None:
        with self.lock:
            session.pending_context_restore = None
            session.pending_context_review = None
            safe_user_message = sanitize_text(user_message)
            safe_user_attachments = normalize_attachment_records(user_attachments)
            user_record_index = len(session.transcript)
            user_blocks = (
                [{"kind": "text", "text": safe_user_message}]
                if safe_user_message
                else []
            )
            safe_assistant_blocks = sanitize_value(assistant_blocks or [])
            assistant_text = message_blocks_to_text(safe_assistant_blocks) or sanitize_text(answer)
            assistant_record_index = user_record_index + 1
            assistant_tool_events = [serialize_tool_event(event) for event in tool_events]
            safe_assistant_provider_items = normalize_provider_items(assistant_provider_items)
            if not safe_assistant_provider_items:
                safe_assistant_provider_items = build_provider_items_for_record(
                    role="assistant",
                    text=assistant_text,
                    attachments=[],
                    tool_events=assistant_tool_events,
                    blocks=safe_assistant_blocks,
                    record_index=assistant_record_index,
                )
            session.transcript.append(
                {
                    "role": "user",
                    "text": safe_user_message,
                    "attachments": safe_user_attachments,
                    "toolEvents": [],
                    "blocks": user_blocks,
                    "providerItems": build_provider_items_for_record(
                        role="user",
                        text=safe_user_message,
                        attachments=safe_user_attachments,
                        tool_events=[],
                        blocks=user_blocks,
                        record_index=user_record_index,
                    ),
                }
            )
            session.transcript.append(
                {
                    "role": "assistant",
                    "text": assistant_text,
                    "attachments": [],
                    "toolEvents": assistant_tool_events,
                    "blocks": safe_assistant_blocks,
                    "providerItems": safe_assistant_provider_items,
                }
            )
            ensure_initial_context_revision(session)
            sync_active_context_revision_snapshot(session)
            self._hydrate_agent_locked(session)
            self._remove_session_from_lists_locked(session.session_id)
            self._insert_session_locked(session)
            self._save_state_locked()

    def bootstrap_payload(self) -> dict[str, object]:
        with self.lock:
            self._ensure_default_project_locked()
            return {
                "project_name": self.settings.project_root.name or str(self.settings.project_root),
                "project_root": str(self.settings.project_root),
                "default_model": self.settings.model,
                "models": model_options(self.settings.model, active_provider_models(self.settings)),
                "reasoning_options": DEFAULT_REASONING_OPTIONS,
                "settings": settings_payload(self.settings),
                "projects": self._projects_payload_locked(),
                "chat_sessions": self._chat_sessions_payload_locked(),
                "conversations": self._conversation_map_locked(),
                "context_inputs": self._context_input_map_locked(),
                "context_workbench_histories": self._context_workbench_history_map_locked(),
                "context_revision_histories": self._context_revision_map_locked(),
                "pending_context_restores": self._pending_context_restore_map_locked(),
                "pending_context_reviews": self._pending_context_review_map_locked(),
            }

    def sidebar_payload(self) -> dict[str, object]:
        with self.lock:
            return {
                "projects": self._projects_payload_locked(),
                "chat_sessions": self._chat_sessions_payload_locked(),
            }

    def session_payload(self, session: SessionState) -> dict[str, object]:
        return {
            "id": session.session_id,
            "title": session.title,
            "scope": session.scope,
            "project_id": session.project_id,
        }

    def _load_state(self) -> None:
        raw_state = self.state_store.load_state()

        projects_data = raw_state.get("projects")
        if isinstance(projects_data, list):
            for item in projects_data:
                if not isinstance(item, dict):
                    continue
                project_id = sanitize_text(item.get("id") or uuid.uuid4().hex).strip()
                title = sanitize_text(item.get("title") or "").strip()
                session_ids = [
                    sanitize_text(session_id).strip()
                    for session_id in item.get("session_ids", [])
                    if sanitize_text(session_id).strip()
                ]
                if not title:
                    continue
                archived_session_ids = [
                    sanitize_text(session_id).strip()
                    for session_id in item.get("archived_session_ids", [])
                    if sanitize_text(session_id).strip()
                ]
                root_path = self._coerce_project_root_path(item.get("root_path"))
                self.projects.append(
                    ProjectState(
                        project_id=project_id,
                        title=title,
                        session_ids=session_ids,
                        root_path=root_path,
                        archived_session_ids=archived_session_ids,
                    )
                )

        sessions_data = raw_state.get("sessions")
        if isinstance(sessions_data, dict):
            for session_id, item in sessions_data.items():
                if not isinstance(item, dict):
                    continue
                safe_session_id = sanitize_text(session_id).strip()
                if not safe_session_id:
                    continue
                scope = self._normalize_scope(item.get("scope"))
                project_id = sanitize_text(item.get("project_id") or "").strip() or None
                transcript = normalize_transcript(item.get("transcript"))
                session = SessionState(
                    session_id=safe_session_id,
                    title=sanitize_text(item.get("title") or NEW_SESSION_TITLE).strip() or NEW_SESSION_TITLE,
                    scope=scope,
                    project_id=project_id if scope == "project" else None,
                    agent=SessionAgent(self._settings_for_project_locked(project_id if scope == "project" else None)),
                    transcript=transcript,
                    context_input=[],
                    context_workbench_history=normalize_context_chat_history(item.get("context_workbench_history")),
                    context_revisions=normalize_context_revision_entries(item.get("context_revisions")),
                    pending_context_restore=normalize_pending_context_restore(item.get("pending_context_restore")),
                    pending_context_review=normalize_pending_context_review(item.get("pending_context_review")),
                    usage_summary=normalize_usage_summary(item.get("usage_summary"), session_id),
                )
                self._hydrate_agent_locked(session)
                self.sessions[safe_session_id] = session

        raw_chat_session_ids = raw_state.get("chat_session_ids", [])
        if isinstance(raw_chat_session_ids, list):
            self.chat_session_ids = [
                sanitize_text(session_id).strip()
                for session_id in raw_chat_session_ids
                if sanitize_text(session_id).strip()
            ]

        with self.lock:
            self._repair_state_locked()
            self._save_state_locked()

    def _repair_state_locked(self) -> None:
        default_project = self._ensure_default_project_locked()

        known_project_ids = {project.project_id for project in self.projects}
        for project in self.projects:
            cleaned_ids: list[str] = []
            for session_id in project.session_ids:
                session = self.sessions.get(session_id)
                if session is None:
                    continue
                if session.scope != "project":
                    continue
                if session.project_id != project.project_id:
                    session.project_id = project.project_id
                if session_id not in cleaned_ids:
                    cleaned_ids.append(session_id)
            project.session_ids = cleaned_ids

            cleaned_archived_ids: list[str] = []
            for session_id in project.archived_session_ids or []:
                session = self.sessions.get(session_id)
                if session is None:
                    continue
                if session.scope != "project":
                    continue
                if session.project_id != project.project_id:
                    session.project_id = project.project_id
                if session_id not in cleaned_archived_ids:
                    cleaned_archived_ids.append(session_id)
            project.archived_session_ids = cleaned_archived_ids

        cleaned_chat_ids: list[str] = []
        for session_id in self.chat_session_ids:
            session = self.sessions.get(session_id)
            if session is None or session.scope != "chat":
                continue
            if session_id not in cleaned_chat_ids:
                cleaned_chat_ids.append(session_id)
        self.chat_session_ids = cleaned_chat_ids

        referenced_session_ids = set(self.chat_session_ids)
        for project in self.projects:
            referenced_session_ids.update(project.session_ids)
            referenced_session_ids.update(project.archived_session_ids or [])

        for session in self.sessions.values():
            ensure_initial_context_revision(session)
            if session.scope == "chat":
                if session.session_id not in referenced_session_ids:
                    self.chat_session_ids.append(session.session_id)
                continue

            if session.project_id not in known_project_ids:
                session.project_id = default_project.project_id

            owning_project = self._find_project_locked(session.project_id) or default_project
            if (
                session.session_id not in owning_project.session_ids
                and session.session_id not in (owning_project.archived_session_ids or [])
            ):
                owning_project.session_ids.append(session.session_id)

    def _save_state_locked(self) -> None:
        payload = {
            "projects": [
                {
                    "id": project.project_id,
                    "title": project.title,
                    "session_ids": project.session_ids,
                    "archived_session_ids": project.archived_session_ids or [],
                    "root_path": project.root_path or "",
                }
                for project in self.projects
            ],
            "chat_session_ids": self.chat_session_ids,
            "sessions": {
                session_id: {
                    "title": session.title,
                    "scope": session.scope,
                    "project_id": session.project_id,
                    "transcript": sanitize_value(session.transcript),
                    "context_workbench_history": sanitize_value(session.context_workbench_history),
                    "context_revisions": sanitize_value(session.context_revisions),
                    "pending_context_restore": sanitize_value(session.pending_context_restore),
                    "pending_context_review": sanitize_value(session.pending_context_review),
                    "usage_summary": sanitize_value(session.usage_summary),
                }
                for session_id, session in self.sessions.items()
            },
        }
        self.state_store.save_state(payload)

    def _ensure_default_project_locked(self) -> ProjectState:
        project = self._find_project_locked(DEFAULT_PROJECT_ID)
        title = self.settings.project_root.name or str(self.settings.project_root)
        if project is not None:
            if not project.title:
                project.title = title
            if not project.root_path:
                project.root_path = str(self.settings.project_root)
            if project.archived_session_ids is None:
                project.archived_session_ids = []
            return project

        project = ProjectState(
            project_id=DEFAULT_PROJECT_ID,
            title=title,
            session_ids=[],
            root_path=str(self.settings.project_root),
            archived_session_ids=[],
        )
        self.projects.append(project)
        return project

    def _find_project_locked(self, project_id: str | None) -> ProjectState | None:
        safe_project_id = sanitize_text(project_id or "").strip()
        if not safe_project_id:
            return None
        for project in self.projects:
            if project.project_id == safe_project_id:
                return project
        return None

    def _projects_payload_locked(self) -> list[dict[str, object]]:
        payload: list[dict[str, object]] = []
        for project in self.projects:
            payload.append(
                {
                    "id": project.project_id,
                    "title": project.title,
                    "root_path": project.root_path or "",
                    "sessions": [
                        self.session_payload(self.sessions[session_id])
                        for session_id in project.session_ids
                        if session_id in self.sessions
                    ],
                }
            )
        return payload

    def _context_workbench_history_map_locked(self) -> dict[str, list[dict[str, str]]]:
        return {
            session_id: sanitize_value(session.context_workbench_history)
            for session_id, session in self.sessions.items()
            if session.context_workbench_history
        }

    def _context_revision_map_locked(self) -> dict[str, list[dict[str, object]]]:
        return {
            session_id: context_revision_summaries(session.context_revisions)
            for session_id, session in self.sessions.items()
            if session.context_revisions
        }

    def _pending_context_restore_map_locked(self) -> dict[str, dict[str, object]]:
        return {
            session_id: context_pending_restore_payload(session.pending_context_restore)
            for session_id, session in self.sessions.items()
            if session.pending_context_restore
        }

    def _pending_context_review_map_locked(self) -> dict[str, dict[str, object]]:
        return {
            session_id: payload
            for session_id, session in self.sessions.items()
            if (payload := pending_context_review_payload(session.pending_context_review)) is not None
        }

    def _chat_sessions_payload_locked(self) -> list[dict[str, object]]:
        return [
            self.session_payload(self.sessions[session_id])
            for session_id in self.chat_session_ids
            if session_id in self.sessions
        ]

    def _conversation_map_locked(self) -> dict[str, list[dict[str, object]]]:
        return {
            session_id: sanitize_value(session.transcript)
            for session_id, session in self.sessions.items()
        }

    def _context_input_map_locked(self) -> dict[str, list[dict[str, object]]]:
        return {
            session_id: sanitize_value(session.context_input)
            for session_id, session in self.sessions.items()
        }

    def _insert_session_locked(self, session: SessionState) -> None:
        if session.scope == "project":
            project = self._find_project_locked(session.project_id) or self._ensure_default_project_locked()
            session.project_id = project.project_id
            project.session_ids.insert(0, session.session_id)
            return

        self.chat_session_ids.insert(0, session.session_id)

    def _remove_session_from_lists_locked(self, session_id: str) -> None:
        if session_id in self.chat_session_ids:
            self.chat_session_ids.remove(session_id)
        for project in self.projects:
            if session_id in project.session_ids:
                project.session_ids.remove(session_id)

    def _coerce_project_title(self, raw_title: str | None, root_path: str | None = None) -> str:
        safe_title = sanitize_text(raw_title or "").strip()
        if safe_title:
            return safe_title

        if root_path:
            path_title = Path(root_path).name
            if path_title:
                return path_title

        existing_titles = {project.title for project in self.projects}
        index = 1
        while True:
            candidate = f"{NEW_PROJECT_PREFIX} {index}"
            if candidate not in existing_titles:
                return candidate
            index += 1

    def _coerce_project_root_path(self, raw_root_path: Any) -> str | None:
        safe_root_path = sanitize_text(raw_root_path or "").strip()
        if not safe_root_path:
            return None

        try:
            root_path = Path(safe_root_path).expanduser()
            if not root_path.is_absolute():
                root_path = (REPO_ROOT / root_path).resolve()
            else:
                root_path = root_path.resolve()
        except (OSError, RuntimeError, ValueError):
            return None

        return str(root_path) if root_path.is_dir() else None

    def _settings_for_session_locked(self, session: SessionState) -> Settings:
        return self._settings_for_project_locked(session.project_id if session.scope == "project" else None)

    def _settings_for_project_locked(self, project_id: str | None) -> Settings:
        project = self._find_project_locked(project_id)
        root_path = self.settings.project_root
        if project and project.root_path:
            try:
                candidate = Path(project.root_path).expanduser().resolve()
                if candidate.is_dir():
                    root_path = candidate
            except (OSError, RuntimeError, ValueError):
                root_path = self.settings.project_root
        return replace(self.settings, project_root=root_path)

    def _normalize_scope(self, raw_scope: Any) -> str:
        return "project" if sanitize_text(raw_scope or "").strip() == "project" else "chat"

    def _hydrate_agent_locked(self, session: SessionState) -> None:
        session.agent.reset()
        session.agent.history = []
        normalized_transcript = normalize_transcript(session.transcript)
        session.transcript = normalized_transcript
        for record_index, record in enumerate(normalized_transcript):
            role = sanitize_text(record.get("role") or "").strip()
            if role not in {"user", "assistant"}:
                continue

            provider_items = build_provider_items_for_record(
                role=role,
                text=sanitize_text(record.get("text") or ""),
                attachments=normalize_attachment_records(record.get("attachments")),
                tool_events=sanitize_value(record.get("toolEvents")) if isinstance(record.get("toolEvents"), list) else [],
                blocks=normalize_message_blocks(record.get("blocks")),
                record_index=record_index,
            )
            session.agent.history.extend(provider_items)
        session.context_input = provider_input_to_context_records(session.agent.request_input_snapshot())

    def update_session_context_input(
        self,
        session: SessionState,
        input_items: list[dict[str, Any]],
    ) -> list[dict[str, object]]:
        with self.lock:
            session.context_input = provider_input_to_context_records(input_items)
            return sanitize_value(session.context_input)


def summarize_title(message: str) -> str:
    compact = " ".join(sanitize_text(message).split())
    if not compact:
        return NEW_SESSION_TITLE
    if len(compact) <= 18:
        return compact
    return f"{compact[:18]}..."


def clean_generated_title(raw_title: str) -> str:
    safe_title = sanitize_text(raw_title).strip()
    if not safe_title:
        return ""

    first_line = next((line.strip() for line in safe_title.splitlines() if line.strip()), "")
    if not first_line:
        return ""

    cleaned = first_line.strip(" \t\r\n\"'`“”‘’「」『』《》")
    cleaned = re.sub(r"^(标题|对话标题)\s*[:：]\s*", "", cleaned).strip()
    cleaned = cleaned.rstrip("。？！?!：:")
    if not cleaned or cleaned == NEW_SESSION_TITLE:
        return ""
    if len(cleaned) <= 18:
        return cleaned
    return f"{cleaned[:18]}..."


def generate_session_title(
    settings: Settings,
    message: str,
    *,
    model: str | None = None,
) -> str:
    safe_message = sanitize_text(message).strip()
    fallback_title = summarize_title(safe_message)
    if not safe_message:
        return fallback_title

    title_agent = SessionAgent(settings)
    request_model = sanitize_text(model or settings.model).strip() or settings.model
    title_prompt = "\n".join(
        [
            "请根据下面这条新对话的第一条用户消息，生成一个对话标题。",
            "",
            safe_message,
        ]
    )

    try:
        response = title_agent._stream_response(
            model=request_model,
            instructions=TITLE_GENERATION_INSTRUCTIONS,
            input=[
                SessionAgent._message(
                    "user",
                    title_prompt,
                )
            ],
            tools=[],
        )
    except Exception:  # noqa: BLE001
        return fallback_title

    title = clean_generated_title(getattr(response, "output_text", ""))
    return title or fallback_title


def should_show_workspace_entry(name: str) -> bool:
    return name not in HIDDEN_WORKSPACE_ENTRIES


def has_visible_children(directory_path: Path) -> bool:
    try:
        return any(should_show_workspace_entry(child.name) for child in directory_path.iterdir())
    except OSError:
        return False


def list_workspace_entries(project_root: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for child in sorted(
        (entry for entry in project_root.iterdir() if should_show_workspace_entry(entry.name)),
        key=lambda item: (not item.is_dir(), item.name.lower()),
    )[:200]:
        entries.append(
            {
                "name": child.name,
                "type": "directory" if child.is_dir() else "file",
                "relative_path": child.relative_to(project_root).as_posix(),
                "has_children": child.is_dir() and has_visible_children(child),
            }
        )
    return entries


def serialize_tool_event(event: ToolEvent) -> dict[str, object]:
    return {
        "name": event.name,
        "arguments": event.arguments,
        "output_preview": event.output_preview,
        "raw_output": event.raw_output,
        "display_title": event.display_title,
        "display_detail": event.display_detail,
        "display_result": event.display_result,
        "status": event.status,
    }


def settings_payload(settings: Settings) -> dict[str, object]:
    return settings.public_payload()


def context_workbench_settings_payload(settings: Settings) -> dict[str, object]:
    return {
        "context_workbench_model": sanitize_text(settings.context_workbench_model or settings.model).strip()
        or sanitize_text(settings.model).strip()
        or "gpt-5.4-mini",
        "context_workbench_provider_id": sanitize_text(
            settings.context_workbench_provider_id or settings.active_provider_id
        ).strip()
        or sanitize_text(settings.active_provider_id).strip()
        or "openai",
        "context_token_warning_threshold": int(settings.context_token_warning_threshold or 5000),
        "context_token_critical_threshold": int(settings.context_token_critical_threshold or 10000),
        "context_review_auto_enabled": bool(settings.context_review_auto_enabled),
        "context_review_interval_minutes": int(settings.context_review_interval_minutes or 10),
    }


def estimate_provider_item_token_count(item: dict[str, Any]) -> int:
    item_type = sanitize_text(item.get("type") or "").strip()
    if item_type == "message":
        return estimate_token_count(extract_text_from_provider_message_content(item.get("content")))

    if item_type == "function_call":
        source = "\n".join(
            part
            for part in [
                sanitize_text(item.get("name") or ""),
                sanitize_text(item.get("arguments") or ""),
            ]
            if part.strip()
        )
        return estimate_token_count(source)

    if item_type == "function_call_output":
        return estimate_token_count(sanitize_text(item.get("output") or ""))

    return 0


def estimate_tool_schema_token_count(schema: dict[str, Any]) -> int:
    parts = [
        sanitize_text(schema.get("name") or ""),
        sanitize_text(schema.get("description") or ""),
    ]
    parameters = schema.get("parameters")
    if isinstance(parameters, dict):
        parts.append(json.dumps(sanitize_value(parameters), ensure_ascii=False))
    elif parameters is not None:
        parameter_text = sanitize_text(parameters)
        if parameter_text.strip():
            parts.append(parameter_text)

    return estimate_token_count("\n".join(part for part in parts if part.strip()))


def debug_request_item_summary(item: Any, index: int) -> dict[str, object]:
    item_json = json.dumps(sanitize_value(item), ensure_ascii=False)
    summary: dict[str, object] = {
        "index": index,
        "json_chars": len(item_json),
    }
    if not isinstance(item, dict):
        summary["type"] = type(item).__name__
        return summary

    item_type = sanitize_text(item.get("type") or "").strip()
    summary["type"] = item_type or "unknown"
    if item_type == "message":
        summary["role"] = sanitize_text(item.get("role") or "").strip()
        text = extract_text_from_provider_message_content(item.get("content"))
        summary["text_chars"] = len(text)
        summary["preview"] = block_text_preview(text, limit=120)
        return summary

    if item_type == "function_call":
        summary["name"] = sanitize_text(item.get("name") or "").strip()
        summary["call_id"] = sanitize_text(item.get("call_id") or "").strip()
        summary["arguments_chars"] = len(sanitize_text(item.get("arguments") or ""))
        return summary

    if item_type == "function_call_output":
        output = sanitize_text(item.get("output") or "")
        summary["call_id"] = sanitize_text(item.get("call_id") or "").strip()
        summary["output_chars"] = len(output)
        summary["preview"] = block_text_preview(output, limit=120)
        return summary

    return summary


def write_context_request_debug(
    *,
    session_id: str,
    request_model: str,
    round_count: int,
    request: dict[str, Any],
    note: str,
) -> None:
    try:
        input_items = request.get("input")
        tools = request.get("tools")
        input_list = input_items if isinstance(input_items, list) else []
        tool_list = tools if isinstance(tools, list) else []
        payload = {
            "created_at": utc_timestamp(),
            "pid": os.getpid(),
            "state_file": str(STATE_FILE),
            "state_db_file": str(STATE_DB_FILE),
            "session_id": session_id,
            "model": request_model,
            "round_count": round_count,
            "note": note,
            "request_json_chars": len(json.dumps(sanitize_value(request), ensure_ascii=False)),
            "input_count": len(input_list),
            "input_json_chars": len(json.dumps(sanitize_value(input_list), ensure_ascii=False)),
            "tools_count": len(tool_list),
            "tools_json_chars": len(json.dumps(sanitize_value(tool_list), ensure_ascii=False)),
            "items": [
                debug_request_item_summary(item, index)
                for index, item in enumerate(input_list)
            ],
        }
        CONTEXT_REQUEST_DEBUG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with CONTEXT_REQUEST_DEBUG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        return


def extract_response_output_text(response: Any) -> str:
    direct_text = sanitize_text(getattr(response, "output_text", "") or "").strip()
    if direct_text:
        return direct_text

    text_parts: list[str] = []
    for item in getattr(response, "output", []) or []:
        if sanitize_text(getattr(item, "type", "")).strip() != "message":
            continue

        for content_item in getattr(item, "content", None) or []:
            if sanitize_text(getattr(content_item, "type", "")).strip() != "output_text":
                continue
            text_parts.append(sanitize_text(getattr(content_item, "text", "") or ""))

    return sanitize_text("".join(text_parts)).strip()


def response_output_to_turn_items(response: Any) -> tuple[list[dict[str, Any]], list[Any]]:
    turn_items: list[dict[str, Any]] = []
    function_calls: list[Any] = []

    for item in getattr(response, "output", []) or []:
        item_type = sanitize_text(getattr(item, "type", "")).strip()
        if item_type == "message":
            role = sanitize_text(getattr(item, "role", "")).strip() or "assistant"
            text_parts: list[str] = []
            for content_item in getattr(item, "content", None) or []:
                if sanitize_text(getattr(content_item, "type", "")).strip() != "output_text":
                    continue
                text_parts.append(sanitize_text(getattr(content_item, "text", "") or ""))

            message_text = "".join(text_parts)
            if message_text.strip():
                turn_items.append(SessionAgent._message(role, message_text))
            continue

        if item_type == "function_call":
            function_calls.append(item)
            turn_items.append(
                {
                    "type": "function_call",
                    "call_id": sanitize_text(getattr(item, "call_id", "") or ""),
                    "name": sanitize_text(getattr(item, "name", "") or ""),
                    "arguments": sanitize_text(getattr(item, "arguments", "") or "{}") or "{}",
                }
            )

    return normalize_provider_items(turn_items), function_calls


def build_context_chat_runtime(
    session: SessionState,
    *,
    message: str,
    selected_indexes: list[int] | None = None,
) -> tuple[str, str, ContextWorkbenchDraft, ContextWorkbenchToolRegistry, list[dict[str, Any]]]:
    safe_selected_indexes = normalize_selected_node_indexes(selected_indexes or [], len(session.transcript))
    draft = ContextWorkbenchDraft(normalize_transcript(session.transcript), safe_selected_indexes)
    snapshot = build_context_workspace_snapshot(session, selected_indexes=safe_selected_indexes)
    tool_registry = ContextWorkbenchToolRegistry(draft, session.title)
    history = prepare_context_chat_history_for_model(session.context_workbench_history)

    context_input: list[dict[str, Any]] = [
        SessionAgent._message(
            "user",
            "\n\n".join(
                [
                    "Current context snapshot for this round:",
                    snapshot,
                ]
            ),
        )
    ]

    for item in history:
        context_input.append(
            SessionAgent._message(
                item["role"],
                item["content"],
            )
        )

    context_input.append(
        SessionAgent._message(
            "user",
            sanitize_text(message),
        )
    )

    request_model = sanitize_text(
        session.agent.settings.context_workbench_model or session.agent.settings.model
    ).strip() or "gpt-5.4-mini"
    instructions = "\n".join(
        [
            "你在右侧上下文工作区里工作，这是一个独立聊天窗口。",
            "默认先像正常聊天助手一样回应用户当前这句话，不要先背职责，也不要先讲工具。",
            "你只处理当前上下文，不继续用户的主聊天任务。",
            "只有在定位、核实、删除、替换或压缩上下文时，才调用上下文工具。",
            "本轮里的 Node # 都以当前快照为准；需要读取或修改节点时，必须显式传 node_numbers。",
            "assistant 节点在编辑前必须先用 get_nodes 读取完整内容，不能根据预览编造摘要。",
            "节点级修改统一使用 write_nodes，并尽量在一次调用中提交完整的删除和插入计划。",
            "只有必须保留 assistant 节点内部部分结构时，才先 get_nodes 再使用 write_items。",
            "写工具只修改 working snapshot；本轮结束后系统会一次性提交并生成可恢复版本。",
            "写工具返回 updated_snapshot 后先核对结果，再简洁说明改了什么和保留了什么。",
            "回答保持简洁、具体、说人话，可以使用 Markdown。",
        ]
    )
    return instructions, request_model, draft, tool_registry, context_input


def build_context_review_runtime(
    session: SessionState,
) -> tuple[str, str, ContextWorkbenchDraft, ContextWorkbenchToolRegistry, list[dict[str, Any]]]:
    transcript = normalize_transcript(session.transcript)
    draft = ContextWorkbenchDraft(transcript, [])
    snapshot = build_context_workspace_snapshot(session, selected_indexes=[])
    tool_registry = ContextWorkbenchToolRegistry(draft, session.title, review_mode=True)
    request_model = sanitize_text(
        session.agent.settings.context_workbench_model or session.agent.settings.model
    ).strip() or "gpt-5.4-mini"
    instructions = "\n".join(
        [
            "你是 HashCode 的上下文维护 Agent，现在只生成一份待用户审核的整理提案。",
            "不要继续主聊天任务，也不要直接修改正式上下文。",
            "保守、选择性地整理：保留当前目标、近期工作集、用户约束、已确认决策、未完成工作和未来仍需引用的证据。",
            "优先处理已经完成或被替代的阶段、重复输出、已纠正错误、放弃的方法和明显过期的探索。",
            "信心不足就保留原内容；不要为了缩短而压缩干净连贯的对话，也不要默认把全文折叠成一个摘要。",
            "assistant 节点的预览不足以支持安全摘要；自动建议不能展开详情，因此只有从快照已有信息就能安全判断时才整理。",
            "如果没有明确且安全的收益，不调用工具，直接回答 NO_CHANGE。",
            "如果值得整理，只调用一次 write_nodes，提交完整删除和插入计划，并提供面向用户的 review_rationale。",
            "review_rationale 使用建议语气，说明建议整理什么、为什么与当前任务有关、保留了什么以及存在什么风险。",
            "review_rationale 不得提节点编号、Token、工具名或草稿机制。",
        ]
    )
    context_input = [
        SessionAgent._message(
            "user",
            "\n\n".join(
                [
                    "请审查下面的当前上下文，并按规则决定是否提出整理建议：",
                    snapshot,
                ]
            ),
        )
    ]
    return instructions, request_model, draft, tool_registry, context_input


def resolve_context_workbench_provider_id(settings: Settings, model_id: str) -> str:
    requested_provider_id = sanitize_text(
        settings.context_workbench_provider_id or settings.active_provider_id
    ).strip()
    enabled_providers = [
        provider
        for provider in settings.response_providers
        if bool(provider.get("enabled"))
    ]
    enabled_provider_ids = {
        sanitize_text(provider.get("id") or "").strip()
        for provider in enabled_providers
        if sanitize_text(provider.get("id") or "").strip()
    }

    cleaned_model_id = sanitize_text(model_id).strip()
    if cleaned_model_id:
        if requested_provider_id and requested_provider_id in enabled_provider_ids:
            requested_provider = next(
                (
                    provider
                    for provider in enabled_providers
                    if sanitize_text(provider.get("id") or "").strip() == requested_provider_id
                ),
                None,
            )
            requested_provider_model_ids = {
                sanitize_text(model.get("id") or "").strip()
                for model in (requested_provider or {}).get("models") or []
                if sanitize_text(model.get("id") or "").strip()
            }
            if cleaned_model_id in requested_provider_model_ids:
                return requested_provider_id

        for provider in enabled_providers:
            provider_id = sanitize_text(provider.get("id") or "").strip()
            if not provider_id:
                continue
            provider_model_ids = {
                sanitize_text(model.get("id") or "").strip()
                for model in provider.get("models") or []
                if sanitize_text(model.get("id") or "").strip()
            }
            if cleaned_model_id in provider_model_ids:
                return provider_id

    if requested_provider_id and requested_provider_id in enabled_provider_ids:
        return requested_provider_id

    active_provider_id = sanitize_text(settings.active_provider_id or "").strip()
    if active_provider_id in enabled_provider_ids:
        return active_provider_id

    return next(iter(enabled_provider_ids), active_provider_id or "openai")


def build_context_workbench_agent(settings: Settings, provider_id: str) -> SessionAgent:
    resolved_provider_id = sanitize_text(provider_id).strip() or sanitize_text(settings.active_provider_id).strip() or "openai"
    provider = next(
        (
            item
            for item in settings.response_providers
            if sanitize_text(item.get("id") or "").strip() == resolved_provider_id
        ),
        settings.active_provider(),
    )
    provider_api_key = sanitize_text(provider.get("api_key") or "").strip() or settings.openai_api_key
    provider_base_url = sanitize_text(provider.get("api_base_url") or "").strip() or settings.openai_base_url
    scoped_settings = Settings(
        model=settings.model,
        default_reasoning_effort=settings.default_reasoning_effort,
        context_workbench_model=settings.context_workbench_model,
        context_workbench_provider_id=resolved_provider_id,
        project_root=settings.project_root,
        max_tool_rounds=settings.max_tool_rounds,
        tool_settings=settings.tool_settings,
        response_providers=settings.response_providers,
        active_provider_id=resolved_provider_id,
        context_token_warning_threshold=settings.context_token_warning_threshold,
        context_token_critical_threshold=settings.context_token_critical_threshold,
        openai_api_key=provider_api_key,
        openai_base_url=provider_base_url,
        assistant_name="",
        assistant_greeting="",
        assistant_prompt="",
        user_name="",
        user_locale="",
        user_timezone="",
        user_profile="",
    )
    return SessionAgent(scoped_settings, include_default_instructions=False)


def run_context_chat_turn(
    session: SessionState,
    *,
    message: str,
    selected_indexes: list[int] | None = None,
    reasoning_effort: str | None = None,
    on_text_delta: Callable[[str], None] | None = None,
    on_round_reset: Callable[[], None] | None = None,
    on_tool_event: Callable[[ToolEvent], None] | None = None,
    check_cancelled: Callable[[], None] | None = None,
    review_mode: bool = False,
) -> tuple[str, str, ContextWorkbenchDraft, list[ToolEvent], list[dict[str, Any]]]:
    if review_mode:
        instructions, request_model, draft, tool_registry, context_input = build_context_review_runtime(session)
    else:
        instructions, request_model, draft, tool_registry, context_input = build_context_chat_runtime(
            session,
            message=message,
            selected_indexes=selected_indexes,
        )
    context_provider_id = resolve_context_workbench_provider_id(session.agent.settings, request_model)
    context_agent = build_context_workbench_agent(session.agent.settings, context_provider_id)
    tool_events: list[ToolEvent] = []
    readonly_tool_result_cache: dict[str, str] = {}
    readonly_tool_cache_names = {"get_nodes"}

    round_count = 0
    while True:
        round_count += 1

        if check_cancelled is not None:
            check_cancelled()

        def build_request() -> dict[str, Any]:
            request = {
                "model": request_model,
                "input": sanitize_value(
                    [
                        SessionAgent._message(context_agent.context_role, instructions),
                        *context_input,
                    ]
                ),
                "tools": tool_registry.schemas,
            }
            if reasoning_effort:
                request["reasoning"] = {"effort": reasoning_effort}
            write_context_request_debug(
                session_id=session.session_id,
                request_model=request_model,
                round_count=round_count,
                request=request,
                note="context_review_request" if review_mode else "context_workbench_request",
            )
            return request

        try:
            response = context_agent._stream_response(
                **build_request(),
                on_text_delta=on_text_delta,
            )
        except Exception as exc:
            if not context_agent._should_fallback_to_developer(exc):
                raise

            context_agent._fallback_to_developer_context()
            response = context_agent._stream_response(
                **build_request(),
                on_text_delta=on_text_delta,
            )
        if check_cancelled is not None:
            check_cancelled()

        if not response.function_calls:
            final_answer = sanitize_text(response.output_text).strip()
            if not final_answer:
                error_msg = "Model returned empty response"
                if response.finish_reason:
                    error_msg += f" (Finish reason: {response.finish_reason})"
                raise RuntimeError(error_msg)
            if check_cancelled is not None:
                check_cancelled()
            return (
                final_answer,
                request_model,
                draft,
                tool_events,
                context_agent.pop_usage_records(),
            )

        if response.output_text and on_round_reset is not None:
            if check_cancelled is not None:
                check_cancelled()
            on_round_reset()

        for call in response.function_calls:
            if check_cancelled is not None:
                check_cancelled()
            safe_call_name = sanitize_text(getattr(call, "name", "") or "")
            safe_call_id = sanitize_text(getattr(call, "call_id", "") or "")
            safe_call_arguments = sanitize_text(getattr(call, "arguments", "") or "{}") or "{}"

            try:
                raw_arguments = json.loads(safe_call_arguments)
                arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
                cache_key = ""
                if safe_call_name in readonly_tool_cache_names:
                    cache_key = json.dumps(
                        {
                            "name": safe_call_name,
                            "arguments": sanitize_value(arguments),
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    )

                if cache_key and cache_key in readonly_tool_result_cache:
                    result = json.dumps(
                        {
                            "payload_kind": "cached_tool_result",
                            "tool_name": safe_call_name,
                            "message": "This exact read-only context tool call already ran in this workbench turn. Use the previous function_call_output result instead of requesting it again.",
                        },
                        ensure_ascii=False,
                    )
                    execution = ToolExecution(
                        output_text=result,
                        display_title=safe_call_name,
                        display_detail="cached duplicate tool call",
                        display_result="Duplicate read-only tool call skipped; use the previous result.",
                        status="completed",
                    )
                else:
                    execution = tool_registry.execute(safe_call_name, arguments)
                    if cache_key:
                        readonly_tool_result_cache[cache_key] = sanitize_text(execution.output_text)
                    else:
                        readonly_tool_result_cache.clear()
                result = sanitize_text(execution.output_text)
            except json.JSONDecodeError as exc:
                arguments = {}
                result = json.dumps(
                    {"error": f"invalid tool arguments: {exc.msg}"},
                    ensure_ascii=False,
                )
                execution = ToolExecution(
                    output_text=result,
                    display_title=safe_call_name or "context_workbench_tool",
                    display_detail="tool arguments invalid",
                    display_result=f"Tool arguments are not valid JSON: {exc.msg}",
                    status="error",
                )
            else:
                result = sanitize_text(execution.output_text)

            if check_cancelled is not None:
                check_cancelled()
            safe_arguments = sanitize_value(arguments)
            tool_event = ToolEvent(
                name=safe_call_name,
                arguments=safe_arguments,
                output_preview=session.agent._preview(result),
                raw_output=result,
                display_title=execution.display_title,
                display_detail=execution.display_detail,
                display_result=execution.display_result,
                status=execution.status,
            )
            tool_events.append(tool_event)
            if on_tool_event is not None:
                on_tool_event(tool_event)

            context_input.append(
                {
                    "type": "function_call",
                    "call_id": safe_call_id,
                    "name": safe_call_name,
                    "arguments": safe_call_arguments,
                }
            )
            context_input.append(
                {
                    "type": "function_call_output",
                    "call_id": safe_call_id,
                    "output": result,
                }
            )

    # Note: Loop continues until returns or error inside


def create_context_chat_answer(
    session: SessionState,
    *,
    message: str,
    selected_indexes: list[int] | None = None,
    reasoning_effort: str | None = None,
) -> tuple[str, str, ContextWorkbenchDraft]:
    answer, request_model, draft, _tool_events, _usage_records = run_context_chat_turn(
        session,
        message=message,
        selected_indexes=selected_indexes,
        reasoning_effort=reasoning_effort,
    )
    return answer, request_model, draft


def generate_context_review(
    app_state: AppState,
    session: SessionState,
    *,
    source: str = "manual",
    check_cancelled: Callable[[], None] | None = None,
) -> dict[str, object] | None:
    transcript = normalize_transcript(session.transcript)
    if len(transcript) < 2:
        return None
    base_fingerprint = context_transcript_fingerprint(transcript)
    _answer, used_model, draft, _tool_events, usage_records = run_context_chat_turn(
        session,
        message="",
        selected_indexes=[],
        reasoning_effort=session.agent.settings.default_reasoning_effort,
        check_cancelled=check_cancelled,
        review_mode=True,
    )
    app_state.record_usage_records(session, "context_workbench", usage_records)
    if check_cancelled is not None:
        check_cancelled()
    if not draft.has_changes:
        return None

    proposed_transcript = draft.committed_transcript()
    if context_transcript_fingerprint(proposed_transcript) == base_fingerprint:
        return None
    review = {
        "id": uuid.uuid4().hex,
        "session_id": session.session_id,
        "source": "auto_idle" if source == "auto_idle" else "manual",
        "created_at": utc_timestamp(),
        "summary": draft.revision_summary(),
        "model": used_model,
        "base_context_fingerprint": base_fingerprint,
        "before": context_transcript_stats(transcript),
        "after": context_transcript_stats(proposed_transcript),
        "proposed_transcript": proposed_transcript,
        "operations": sanitize_value(draft.operations),
    }
    return app_state.store_context_review(session, review)


def build_context_chat_response_payload(
    app_state: AppState,
    session: SessionState,
    *,
    user_message: str,
    answer: str,
    used_model: str,
    draft: ContextWorkbenchDraft,
    tool_events: list[ToolEvent] | None = None,
) -> dict[str, object]:
    if draft.has_changes:
        conversation, revisions, pending_restore = app_state.apply_context_workbench_mutation(
            session,
            transcript=draft.committed_transcript(),
            revision_label=draft.revision_label(),
            revision_summary=draft.revision_summary(),
            operations=draft.operations,
        )
    else:
        conversation = sanitize_value(session.transcript)
        revisions = context_revision_summaries(session.context_revisions)
        pending_restore = None

    history = app_state.append_context_workbench_turn(
        session,
        user_message=user_message,
        answer=answer,
    )
    payload: dict[str, object] = {
        "answer": answer,
        "used_model": used_model,
        "history": history,
        "conversation": conversation,
        "context_input": sanitize_value(session.context_input),
        "revisions": revisions,
        "pending_restore": pending_restore,
    }
    if tool_events is not None:
        payload["tool_events"] = [serialize_tool_event(event) for event in tool_events]
    return payload


class HashHTTPRequestHandler(BaseHTTPRequestHandler):
    server_version = "HashCodeWeb/0.2"

    @property
    def app_state(self) -> AppState:
        return self.server.app_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/init":
            self._send_json(self.app_state.bootstrap_payload())
            return

        if parsed.path == "/api/settings":
            self._send_json(
                {
                    "settings": settings_payload(self.app_state.settings),
                    "models": model_options(self.app_state.settings.model, active_provider_models(self.app_state.settings)),
                }
            )
            return

        if parsed.path == "/api/context-workbench-settings":
            settings_data = settings_payload(self.app_state.settings)
            self._send_json(
                {
                    "settings": context_workbench_settings_payload(self.app_state.settings),
                    "models": model_options(
                        self.app_state.settings.context_workbench_model,
                        active_provider_models(self.app_state.settings),
                    ),
                    "response_providers": settings_data.get("response_providers", []),
                    "tool_catalog": ContextWorkbenchToolRegistry.tool_catalog(),
                }
            )
            return

        if parsed.path == "/api/workspace":
            self._send_json(
                {
                    "entries": list_workspace_entries(self.app_state.settings.project_root),
                }
            )
            return

        self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json_body()

            if parsed.path == "/api/projects":
                project = self.app_state.create_project(
                    sanitize_text(payload.get("title") or "").strip() or None,
                    sanitize_text(payload.get("root_path") or "").strip() or None,
                )
                self._send_json(
                    {
                        "project": {
                            "id": project.project_id,
                            "title": project.title,
                            "root_path": project.root_path or "",
                        },
                        **self.app_state.sidebar_payload(),
                    },
                    status=HTTPStatus.CREATED,
                )
                return

            if parsed.path == "/api/pin-project":
                project_id = sanitize_text(payload.get("project_id", "")).strip()
                project = self.app_state.pin_project(project_id)
                self._send_json(
                    {
                        "project": {
                            "id": project.project_id,
                            "title": project.title,
                            "root_path": project.root_path or "",
                        },
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/rename-project":
                project_id = sanitize_text(payload.get("project_id", "")).strip()
                title = sanitize_text(payload.get("title", "")).strip()
                project = self.app_state.rename_project(project_id, title)
                self._send_json(
                    {
                        "project": {
                            "id": project.project_id,
                            "title": project.title,
                            "root_path": project.root_path or "",
                        },
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/archive-project-sessions":
                project_id = sanitize_text(payload.get("project_id", "")).strip()
                project, archived_session_ids = self.app_state.archive_project_sessions(project_id)
                self._send_json(
                    {
                        "project": {
                            "id": project.project_id,
                            "title": project.title,
                            "root_path": project.root_path or "",
                        },
                        "archived_session_ids": archived_session_ids,
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/sessions":
                session = self.app_state.create_session(
                    scope=sanitize_text(payload.get("scope") or "chat"),
                    project_id=sanitize_text(payload.get("project_id") or "").strip() or None,
                )
                self._send_json(
                    {
                        "session": self.app_state.session_payload(session),
                        "context_input": sanitize_value(session.context_input),
                        **self.app_state.sidebar_payload(),
                    },
                    status=HTTPStatus.CREATED,
                )
                return

            if parsed.path == "/api/reset":
                session_id = sanitize_text(payload.get("session_id", "")).strip()
                session = self.app_state.reset_session(session_id)
                self._send_json(
                    {
                        "session": self.app_state.session_payload(session),
                        "context_input": sanitize_value(session.context_input),
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/truncate-session":
                session_id = sanitize_text(payload.get("session_id", "")).strip()
                raw_from_index = payload.get("from_index")
                try:
                    from_index = int(raw_from_index)
                except (TypeError, ValueError) as exc:
                    raise ValueError("from_index must be a number") from exc

                session = self.app_state.truncate_session(session_id, from_index)
                self._send_json(
                    {
                        "session": self.app_state.session_payload(session),
                        "conversation": sanitize_value(session.transcript),
                        "context_input": sanitize_value(session.context_input),
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/delete-message":
                session_id = sanitize_text(payload.get("session_id", "")).strip()
                raw_message_index = payload.get("message_index")
                try:
                    message_index = int(raw_message_index)
                except (TypeError, ValueError) as exc:
                    raise ValueError("message_index must be a number") from exc

                session = self.app_state.get_session(session_id)
                self.app_state.prepare_interactive_request(session)
                request_id = self.app_state.acquire_session_request(session, "main")
                try:
                    session = self.app_state.delete_transcript_message(session_id, message_index)
                    self._send_json(
                        {
                            "session": self.app_state.session_payload(session),
                            "conversation": sanitize_value(session.transcript),
                            "context_input": sanitize_value(session.context_input),
                            **self.app_state.sidebar_payload(),
                        }
                    )
                finally:
                    self.app_state.release_session_request(session, "main", request_id)
                return

            if parsed.path == "/api/settings":
                raw_max_tool_rounds = payload.get("max_tool_rounds")
                max_tool_rounds = None
                if raw_max_tool_rounds not in (None, ""):
                    try:
                        max_tool_rounds = int(raw_max_tool_rounds)
                    except (TypeError, ValueError) as exc:
                        raise ValueError("max_tool_rounds must be a number") from exc

                updated_settings = save_settings(
                    default_model=sanitize_text(payload.get("default_model") or "").strip() or None,
                    default_reasoning_effort=sanitize_text(payload.get("default_reasoning_effort") or "").strip()
                    if "default_reasoning_effort" in payload
                    else None,
                    openai_base_url=sanitize_text(payload.get("openai_base_url") or "").strip(),
                    max_tool_rounds=max_tool_rounds,
                    assistant_name=payload.get("assistant_name") if isinstance(payload.get("assistant_name"), str) else None,
                    assistant_greeting=payload.get("assistant_greeting") if isinstance(payload.get("assistant_greeting"), str) else None,
                    assistant_prompt=payload.get("assistant_prompt") if isinstance(payload.get("assistant_prompt"), str) else None,
                    temperature=payload.get("temperature") if "temperature" in payload else _UNSET,
                    top_p=payload.get("top_p") if "top_p" in payload else _UNSET,
                    context_message_limit=payload.get("context_message_limit") if "context_message_limit" in payload else _UNSET,
                    streaming=bool(payload.get("streaming")) if "streaming" in payload else None,
                    user_name=payload.get("user_name") if isinstance(payload.get("user_name"), str) else None,
                    user_locale=payload.get("user_locale") if isinstance(payload.get("user_locale"), str) else None,
                    user_timezone=payload.get("user_timezone") if isinstance(payload.get("user_timezone"), str) else None,
                    user_profile=payload.get("user_profile") if isinstance(payload.get("user_profile"), str) else None,
                    theme_mode=payload.get("theme_mode") if isinstance(payload.get("theme_mode"), str) else None,
                    service_hints_enabled=bool(payload.get("service_hints_enabled"))
                    if "service_hints_enabled" in payload
                    else None,
                    tool_settings=payload.get("tool_settings")
                    if isinstance(payload.get("tool_settings"), list)
                    else None,
                    openai_api_key=payload.get("openai_api_key") if isinstance(payload.get("openai_api_key"), str) else None,
                    clear_api_key=bool(payload.get("clear_api_key")),
                    active_provider_id=sanitize_text(payload.get("active_provider_id") or "").strip() or None,
                    deleted_provider_ids=payload.get("deleted_provider_ids")
                    if isinstance(payload.get("deleted_provider_ids"), list)
                    else None,
                    response_providers=payload.get("response_providers")
                    if isinstance(payload.get("response_providers"), list)
                    else None,
                )
                self.app_state.refresh_settings(updated_settings)
                self._send_json(
                    {
                        "settings": settings_payload(updated_settings),
                        "models": model_options(updated_settings.model, active_provider_models(updated_settings)),
                    }
                )
                return

            if parsed.path == "/api/provider-model-candidates":
                provider_id = sanitize_text(payload.get("provider_id") or "").strip()
                provider = next(
                    (
                        item
                        for item in self.app_state.settings.response_providers
                        if sanitize_text(item.get("id") or "").strip() == provider_id
                    ),
                    None,
                )
                provider_type = normalize_provider_type(
                    payload.get("provider_type") or (provider.get("provider_type") if provider else ""),
                    provider_id,
                )
                request_base_url = sanitize_text(
                    payload.get("api_base_url") or (provider.get("api_base_url") if provider else "") or ""
                ).strip()
                request_api_key = (
                    payload.get("api_key")
                    if isinstance(payload.get("api_key"), str)
                    else sanitize_text((provider.get("api_key") if provider else "") or "").strip()
                )

                fetched_models = fetch_models_from_provider(request_base_url, request_api_key, provider_type)
                self._send_json(
                    {
                        "provider_id": provider_id,
                        "fetched_count": len(fetched_models),
                        "models": fetched_models,
                    }
                )
                return

            if parsed.path == "/api/provider-models":
                provider_id = sanitize_text(payload.get("provider_id") or "").strip()
                preview_only = bool(payload.get("preview_only"))
                provider = next(
                    (
                        item
                        for item in self.app_state.settings.response_providers
                        if sanitize_text(item.get("id") or "").strip() == provider_id
                    ),
                    None,
                )
                if provider is None and not preview_only:
                    raise ValueError("provider_id is invalid")
                if provider is not None and not bool(provider.get("supports_model_fetch")):
                    raise ValueError("杩欎釜渚涘簲鍟嗘殏鏃朵笉鏀寔鎷夊彇妯″瀷鍒楄〃")

                request_base_url = sanitize_text(
                    payload.get("api_base_url") or (provider.get("api_base_url") if provider else "") or ""
                ).strip()
                request_api_key = (
                    payload.get("api_key")
                    if isinstance(payload.get("api_key"), str)
                    else sanitize_text((provider.get("api_key") if provider else "") or "").strip()
                )
                provider_type = normalize_provider_type(
                    payload.get("provider_type") or (provider.get("provider_type") if provider else ""),
                    provider_id,
                )
                provider_payloads = clone_provider_settings_payloads(self.app_state.settings)
                current_sync_time = datetime.now(timezone.utc).isoformat()

                try:
                    fetched_models = fetch_models_from_provider(request_base_url, request_api_key, provider_type)
                except Exception as exc:
                    if preview_only:
                        raise

                    for item in provider_payloads:
                        if sanitize_text(item.get("id") or "").strip() != provider_id:
                            continue
                        item["api_base_url"] = request_base_url
                        item["last_sync_at"] = current_sync_time
                        item["last_sync_error"] = sanitize_text(str(exc))
                        if isinstance(request_api_key, str) and request_api_key.strip():
                            item["api_key"] = request_api_key.strip()
                        break

                    failed_settings = save_settings(response_providers=provider_payloads)
                    self.app_state.refresh_settings(failed_settings)
                    raise

                if preview_only:
                    self._send_json(
                        {
                            "provider_id": provider_id,
                            "fetched_count": len(fetched_models),
                            "models": fetched_models,
                        }
                    )
                    return

                fetched_default_model = sanitize_text(provider.get("default_model") or "").strip()
                fetched_model_ids = [sanitize_text(model.get("id") or "").strip() for model in fetched_models]
                if not fetched_default_model or fetched_default_model not in fetched_model_ids:
                    fetched_default_model = fetched_model_ids[0]

                for item in provider_payloads:
                    if sanitize_text(item.get("id") or "").strip() != provider_id:
                        continue
                    item["api_base_url"] = request_base_url
                    item["default_model"] = fetched_default_model
                    item["models"] = fetched_models
                    item["last_sync_at"] = current_sync_time
                    item["last_sync_error"] = ""
                    if isinstance(request_api_key, str) and request_api_key.strip():
                        item["api_key"] = request_api_key.strip()
                    break

                updated_settings = save_settings(response_providers=provider_payloads)
                self.app_state.refresh_settings(updated_settings)
                self._send_json(
                    {
                        "settings": settings_payload(updated_settings),
                        "models": model_options(updated_settings.model, active_provider_models(updated_settings)),
                        "provider_id": provider_id,
                        "fetched_count": len(fetched_models),
                    }
                )
                return

            if parsed.path == "/api/context-workbench-settings":
                updated_settings = save_settings(
                    context_workbench_model=sanitize_text(payload.get("context_workbench_model") or "").strip()
                    or None,
                    context_workbench_provider_id=sanitize_text(payload.get("context_workbench_provider_id") or "").strip()
                    or None,
                    context_token_warning_threshold=payload.get("context_token_warning_threshold"),
                    context_token_critical_threshold=payload.get("context_token_critical_threshold"),
                    context_review_auto_enabled=bool(payload.get("context_review_auto_enabled"))
                    if "context_review_auto_enabled" in payload
                    else None,
                    context_review_interval_minutes=payload.get("context_review_interval_minutes"),
                )
                self.app_state.refresh_settings(updated_settings)
                settings_data = settings_payload(updated_settings)
                self._send_json(
                    {
                        "settings": context_workbench_settings_payload(updated_settings),
                        "models": model_options(
                            updated_settings.context_workbench_model,
                            active_provider_models(updated_settings),
                        ),
                        "response_providers": settings_data.get("response_providers", []),
                        "tool_catalog": ContextWorkbenchToolRegistry.tool_catalog(),
                    }
                )
                return

            if parsed.path == "/api/context-review":
                session = self.app_state.get_session(payload.get("session_id"))
                action = sanitize_text(payload.get("action") or "status").strip() or "status"
                if action == "status":
                    self._send_json({"review": self.app_state.context_review_payload(session)})
                    return
                if action == "discard":
                    self.app_state.cancel_scheduled_context_review(session.session_id)
                    self.app_state.discard_context_review(
                        session,
                        sanitize_text(payload.get("review_id") or "").strip() or None,
                    )
                    self._send_json({"review": None})
                    return
                if action == "generate":
                    self.app_state.prepare_interactive_request(session)
                    request_id = self.app_state.acquire_session_request(session, "context")
                    try:
                        review = generate_context_review(self.app_state, session, source="manual")
                        self._send_json({"review": review})
                    finally:
                        self.app_state.release_session_request(session, "context", request_id)
                    return
                if action == "apply":
                    review_id = sanitize_text(payload.get("review_id") or "").strip()
                    if not review_id:
                        raise ValueError("review_id is required")
                    self.app_state.prepare_interactive_request(session)
                    request_id = self.app_state.acquire_session_request(session, "context")
                    try:
                        conversation, revisions, pending_restore = self.app_state.apply_context_review(
                            session,
                            review_id,
                        )
                        self._send_json(
                            {
                                "review": None,
                                "conversation": conversation,
                                "context_input": sanitize_value(session.context_input),
                                "history": sanitize_value(session.context_workbench_history),
                                "revisions": revisions,
                                "pending_restore": pending_restore,
                            }
                        )
                    finally:
                        self.app_state.release_session_request(session, "context", request_id)
                    return
                raise ValueError("invalid context review action")

            if parsed.path == "/api/session-usage":
                session = self.app_state.get_session(payload.get("session_id"))
                action = sanitize_text(payload.get("action") or "status").strip() or "status"
                if action == "status":
                    self._send_json({"summary": self.app_state.session_usage_payload(session)})
                    return
                if action == "reset":
                    self._send_json({"summary": self.app_state.reset_session_usage(session)})
                    return
                raise ValueError("invalid session usage action")

            if parsed.path == "/api/delete-session":
                session_id = sanitize_text(payload.get("session_id", "")).strip()
                session = self.app_state.delete_session(session_id)
                self._send_json(
                    {
                        "deleted_session_id": session.session_id,
                        "deleted_scope": session.scope,
                        "deleted_project_id": session.project_id,
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/delete-project":
                project_id = sanitize_text(payload.get("project_id", "")).strip()
                project, deleted_session_ids = self.app_state.delete_project(project_id)
                self._send_json(
                    {
                        "deleted_project_id": project.project_id,
                        "deleted_session_ids": deleted_session_ids,
                        **self.app_state.sidebar_payload(),
                    }
                )
                return

            if parsed.path == "/api/cancel-request":
                session = self.app_state.get_session(payload.get("session_id"))
                mode = sanitize_text(payload.get("mode") or "main").strip() or "main"
                cancelled = self.app_state.cancel_session_request(session, mode)
                self._send_json({"cancelled": cancelled})
                return

            if parsed.path == "/api/context-chat":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                message = sanitize_text(payload.get("message", "")).strip()
                if not message:
                    raise ValueError("message is required")

                reasoning_effort = sanitize_text(payload.get("reasoning_effort", "")).strip() or None
                if reasoning_effort in {"default", "none"}:
                    reasoning_effort = None
                selected_indexes = normalize_selected_node_indexes(
                    payload.get("selected_node_indexes"),
                    len(session.transcript),
                )
                request_id = self.app_state.acquire_session_request(session, "context")
                try:
                    answer, used_model, draft, tool_events, usage_records = run_context_chat_turn(
                        session,
                        message=message,
                        selected_indexes=selected_indexes,
                        reasoning_effort=reasoning_effort,
                    )
                    self.app_state.record_usage_records(session, "context_workbench", usage_records)
                    self._send_json(
                        build_context_chat_response_payload(
                            self.app_state,
                            session,
                            user_message=message,
                            answer=answer,
                            used_model=used_model,
                            draft=draft,
                            tool_events=tool_events,
                        )
                    )
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/context-chat-stream":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                message = sanitize_text(payload.get("message", "")).strip()
                if not message:
                    raise ValueError("message is required")

                reasoning_effort = sanitize_text(payload.get("reasoning_effort", "")).strip() or None
                if reasoning_effort in {"default", "none"}:
                    reasoning_effort = None
                selected_indexes = normalize_selected_node_indexes(
                    payload.get("selected_node_indexes"),
                    len(session.transcript),
                )
                request_id = self.app_state.acquire_session_request(session, "context")
                self._start_stream_response()

                def raise_if_cancelled() -> None:
                    if self.app_state.is_session_request_cancelled(session, request_id):
                        raise RequestCancelledError()

                def handle_text_delta(delta: str) -> None:
                    raise_if_cancelled()
                    safe_delta = sanitize_text(delta)
                    if not safe_delta:
                        return
                    self._write_stream_event(
                        {
                            "type": "delta",
                            "delta": safe_delta,
                        }
                    )

                def handle_tool_event(event: ToolEvent) -> None:
                    raise_if_cancelled()
                    self._write_stream_event(
                        {
                            "type": "tool_event",
                            "tool_event": serialize_tool_event(event),
                        }
                    )

                def handle_round_reset() -> None:
                    raise_if_cancelled()
                    self._write_stream_event({"type": "reset"})

                try:
                    answer, used_model, draft, tool_events, usage_records = run_context_chat_turn(
                        session,
                        message=message,
                        selected_indexes=selected_indexes,
                        reasoning_effort=reasoning_effort,
                        on_text_delta=handle_text_delta,
                        on_round_reset=handle_round_reset,
                        on_tool_event=handle_tool_event,
                        check_cancelled=raise_if_cancelled,
                    )
                    self.app_state.record_usage_records(session, "context_workbench", usage_records)
                    raise_if_cancelled()
                    payload_data = build_context_chat_response_payload(
                        self.app_state,
                        session,
                        user_message=message,
                        answer=answer,
                        used_model=used_model,
                        draft=draft,
                        tool_events=tool_events,
                    )
                    payload_data["type"] = "done"
                    self._write_stream_event(sanitize_value(payload_data))
                except (ClientDisconnectedError, RequestCancelledError):
                    pass
                except Exception as exc:  # noqa: BLE001
                    try:
                        self._write_stream_event(
                            {
                                "type": "error",
                                "error": sanitize_text(str(exc) or "鏈嶅姟寮傚父"),
                            }
                        )
                    except ClientDisconnectedError:
                        pass
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/context-restore":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                revision_id = sanitize_text(payload.get("revision_id") or "").strip()
                if not revision_id:
                    raise ValueError("revision_id is required")

                request_id = self.app_state.acquire_session_request(session, "context")
                try:
                    conversation, history, revisions, pending_restore = self.app_state.restore_context_revision(
                        session,
                        revision_id,
                    )
                    self._send_json(
                        {
                            "conversation": conversation,
                            "context_input": sanitize_value(session.context_input),
                            "history": history,
                            "revisions": revisions,
                            "pending_restore": pending_restore,
                        }
                    )
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/context-workbench-history-message-delete":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                raw_message_index = payload.get("message_index")
                try:
                    message_index = int(raw_message_index)
                except (TypeError, ValueError) as exc:
                    raise ValueError("message_index must be a number") from exc

                request_id = self.app_state.acquire_session_request(session, "context")
                try:
                    conversation, history, revisions, pending_restore = self.app_state.delete_context_workbench_history_message(
                        session,
                        message_index=message_index,
                    )
                    self._send_json(
                        {
                            "conversation": conversation,
                            "context_input": sanitize_value(session.context_input),
                            "history": history,
                            "revisions": revisions,
                            "pending_restore": pending_restore,
                        }
                    )
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/context-workbench-history-clear":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                request_id = self.app_state.acquire_session_request(session, "context")
                try:
                    conversation, history, revisions, pending_restore = self.app_state.clear_context_workbench_history(
                        session,
                    )
                    self._send_json(
                        {
                            "conversation": conversation,
                            "context_input": sanitize_value(session.context_input),
                            "history": history,
                            "revisions": revisions,
                            "pending_restore": pending_restore,
                        }
                    )
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/context-undo-restore":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                request_id = self.app_state.acquire_session_request(session, "context")
                try:
                    conversation, history, revisions, pending_restore = self.app_state.undo_context_restore(session)
                    self._send_json(
                        {
                            "conversation": conversation,
                            "context_input": sanitize_value(session.context_input),
                            "history": history,
                            "revisions": revisions,
                            "pending_restore": pending_restore,
                        }
                    )
                finally:
                    self.app_state.release_session_request(session, "context", request_id)
                return

            if parsed.path == "/api/send-message-stream":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                self.app_state.discard_context_review(session)
                message = sanitize_text(payload.get("message", "")).strip()
                transcript_attachments, agent_attachments = persist_request_attachments(payload.get("attachments"))
                if not message and not transcript_attachments:
                    raise ValueError("message is required")

                model = sanitize_text(payload.get("model", "")).strip() or None
                reasoning_effort = sanitize_text(payload.get("reasoning_effort", "")).strip() or None
                if reasoning_effort in {"default", "none"}:
                    reasoning_effort = None

                title_seed = message or sanitize_text(transcript_attachments[0].get("name") or "")
                should_name_session = self.app_state.should_name_session_from_first_message(session)
                request_id = self.app_state.acquire_session_request(session, "main")
                if should_name_session:
                    self.app_state.name_session_from_first_message_async(
                        session,
                        title_seed,
                        model=model,
                    )
                self._start_stream_response()
                assistant_blocks: list[dict[str, object]] = []
                active_reasoning_index: int | None = None
                streamed_tool_events: list[ToolEvent] = []
                turn_persisted = False

                def raise_if_cancelled() -> None:
                    if self.app_state.is_session_request_cancelled(session, request_id):
                        raise RequestCancelledError()

                def append_text_block(delta: str) -> None:
                    safe_delta = sanitize_text(delta)
                    if not safe_delta:
                        return

                    if assistant_blocks and assistant_blocks[-1].get("kind") == "text":
                        assistant_blocks[-1]["text"] = sanitize_text(
                            f"{assistant_blocks[-1].get('text', '')}{safe_delta}"
                        )
                    else:
                        assistant_blocks.append(
                            {
                                "kind": "text",
                                "text": safe_delta,
                            }
                        )

                def append_text_delta(delta: str) -> None:
                    safe_delta = sanitize_text(delta)
                    if not safe_delta:
                        return

                    append_text_block(safe_delta)
                    self._write_stream_event(
                        {
                            "type": "delta",
                            "kind": "text",
                            "delta": safe_delta,
                        }
                    )

                def handle_reasoning_start() -> None:
                    nonlocal active_reasoning_index
                    raise_if_cancelled()
                    if active_reasoning_index is not None:
                        return

                    assistant_blocks.append(
                        {
                            "kind": "reasoning",
                            "text": "",
                            "status": "streaming",
                        }
                    )
                    active_reasoning_index = len(assistant_blocks) - 1
                    self._write_stream_event({"type": "reasoning_start"})

                def append_reasoning_delta(delta: str) -> None:
                    nonlocal active_reasoning_index
                    safe_delta = sanitize_text(delta)
                    if not safe_delta:
                        return

                    if active_reasoning_index is None:
                        handle_reasoning_start()
                    if active_reasoning_index is None:
                        return

                    block = assistant_blocks[active_reasoning_index]
                    block["text"] = sanitize_text(f"{block.get('text', '')}{safe_delta}")
                    self._write_stream_event(
                        {
                            "type": "delta",
                            "kind": "reasoning",
                            "delta": safe_delta,
                        }
                    )

                def handle_reasoning_done() -> None:
                    nonlocal active_reasoning_index
                    raise_if_cancelled()
                    if active_reasoning_index is None:
                        return

                    assistant_blocks[active_reasoning_index]["status"] = "completed"
                    active_reasoning_index = None
                    self._write_stream_event({"type": "reasoning_done"})

                think_parser = ThinkTagStreamParser(
                    on_text_delta=append_text_delta,
                    on_reasoning_start=handle_reasoning_start,
                    on_reasoning_delta=append_reasoning_delta,
                    on_reasoning_done=handle_reasoning_done,
                )

                def persist_interrupted_turn() -> None:
                    nonlocal active_reasoning_index, turn_persisted
                    if turn_persisted:
                        return

                    if think_parser.buffer:
                        if think_parser.in_reasoning:
                            if active_reasoning_index is None:
                                assistant_blocks.append(
                                    {
                                        "kind": "reasoning",
                                        "text": "",
                                        "status": "streaming",
                                    }
                                )
                                active_reasoning_index = len(assistant_blocks) - 1
                            block = assistant_blocks[active_reasoning_index]
                            block["text"] = sanitize_text(f"{block.get('text', '')}{think_parser.buffer}")
                        else:
                            append_text_block(think_parser.buffer)
                        think_parser.buffer = ""

                    if active_reasoning_index is not None:
                        assistant_blocks[active_reasoning_index]["status"] = "completed"
                        active_reasoning_index = None

                    interrupted_blocks = normalize_message_blocks(assistant_blocks)
                    display_answer = message_blocks_to_text(interrupted_blocks)
                    has_visible_partial = bool(
                        display_answer
                        or message_blocks_have_reasoning(interrupted_blocks)
                        or any(block.get("kind") == "tool" for block in interrupted_blocks)
                    )
                    if not has_visible_partial:
                        return

                    self.app_state.append_turn(
                        session,
                        user_message=message,
                        answer=display_answer,
                        tool_events=streamed_tool_events,
                        assistant_blocks=interrupted_blocks,
                        user_attachments=transcript_attachments,
                    )
                    self.app_state.schedule_context_review(session)
                    turn_persisted = True

                def handle_model_start() -> None:
                    raise_if_cancelled()
                    self._write_stream_event({"type": "model_start"})

                def handle_model_done() -> None:
                    raise_if_cancelled()
                    think_parser.finish()
                    self._write_stream_event({"type": "model_done"})

                def handle_text_delta(delta: str) -> None:
                    raise_if_cancelled()
                    think_parser.feed(delta)

                def handle_tool_event(event: ToolEvent) -> None:
                    raise_if_cancelled()
                    streamed_tool_events.append(event)
                    serialized_event = serialize_tool_event(event)
                    assistant_blocks.append(
                        {
                            "kind": "tool",
                            "tool_event": serialized_event,
                        }
                    )
                    self._write_stream_event(
                        {
                            "type": "tool_event",
                            "tool_event": serialized_event,
                        }
                    )

                def handle_round_reset() -> None:
                    raise_if_cancelled()
                    think_parser.finish()
                    self._write_stream_event({"type": "reset"})

                def handle_request_input(input_items: list[dict[str, Any]], _request: dict[str, Any]) -> None:
                    raise_if_cancelled()
                    context_input = self.app_state.update_session_context_input(session, input_items)
                    self._write_stream_event(
                        {
                            "type": "context_input",
                            "conversation": context_input,
                        }
                    )

                try:
                    agent_history_start = len(session.agent.history)
                    answer, tool_events = session.agent.run_turn(
                        message,
                        attachments=agent_attachments,
                        model=model,
                        reasoning_effort=reasoning_effort,
                        on_text_delta=handle_text_delta,
                        on_reasoning_start=handle_reasoning_start,
                        on_reasoning_delta=append_reasoning_delta,
                        on_reasoning_done=handle_reasoning_done,
                        on_model_start=handle_model_start,
                        on_model_done=handle_model_done,
                        on_round_reset=handle_round_reset,
                        on_tool_event=handle_tool_event,
                        on_request_input=handle_request_input,
                        check_cancelled=raise_if_cancelled,
                    )
                    raise_if_cancelled()
                    think_parser.finish()
                    assistant_provider_items = assistant_provider_items_from_history_slice(
                        session.agent.history[agent_history_start:]
                    )
                    tool_events_payload = [serialize_tool_event(event) for event in tool_events]
                    if not assistant_blocks:
                        assistant_blocks = blocks_from_text_and_tools(
                            "assistant",
                            answer,
                            tool_events_payload,
                        )
                    else:
                        assistant_blocks = normalize_message_blocks(assistant_blocks)
                    display_answer = message_blocks_to_text(assistant_blocks)
                    if not display_answer and not message_blocks_have_reasoning(assistant_blocks):
                        display_answer = sanitize_text(answer)
                    self.app_state.append_turn(
                        session,
                        user_message=message,
                        answer=display_answer,
                        tool_events=tool_events,
                        assistant_blocks=assistant_blocks,
                        assistant_provider_items=assistant_provider_items,
                        user_attachments=transcript_attachments,
                    )
                    self.app_state.schedule_context_review(session)
                    turn_persisted = True
                    self._write_stream_event(
                        {
                            "type": "done",
                            "answer": display_answer,
                            "tool_events": tool_events_payload,
                            "blocks": assistant_blocks,
                            "session": self.app_state.session_payload(session),
                            "context_input": sanitize_value(session.context_input),
                            **self.app_state.sidebar_payload(),
                        }
                    )
                except (ClientDisconnectedError, RequestCancelledError):
                    persist_interrupted_turn()
                except Exception as exc:  # noqa: BLE001
                    try:
                        self._write_stream_event(
                            {
                                "type": "error",
                                "error": sanitize_text(str(exc) or "鏈嶅姟寮傚父"),
                            }
                        )
                    except ClientDisconnectedError:
                        pass
                finally:
                    self.app_state.record_agent_usage(session, "main")
                    self.app_state.release_session_request(session, "main", request_id)
                return

            if parsed.path == "/api/send-message":
                session = self.app_state.get_session(payload.get("session_id"))
                self.app_state.prepare_interactive_request(session)
                self.app_state.discard_context_review(session)
                message = sanitize_text(payload.get("message", "")).strip()
                transcript_attachments, agent_attachments = persist_request_attachments(payload.get("attachments"))
                if not message and not transcript_attachments:
                    raise ValueError("message is required")

                model = sanitize_text(payload.get("model", "")).strip() or None
                reasoning_effort = sanitize_text(payload.get("reasoning_effort", "")).strip() or None
                if reasoning_effort in {"default", "none"}:
                    reasoning_effort = None

                title_seed = message or sanitize_text(transcript_attachments[0].get("name") or "")
                should_name_session = self.app_state.should_name_session_from_first_message(session)
                request_id = self.app_state.acquire_session_request(session, "main")
                if should_name_session:
                    self.app_state.name_session_from_first_message_async(
                        session,
                        title_seed,
                        model=model,
                    )
                def handle_request_input(input_items: list[dict[str, Any]], _request: dict[str, Any]) -> None:
                    self.app_state.update_session_context_input(session, input_items)

                try:
                    agent_history_start = len(session.agent.history)
                    answer, tool_events = session.agent.run_turn(
                        message,
                        attachments=agent_attachments,
                        model=model,
                        reasoning_effort=reasoning_effort,
                        on_request_input=handle_request_input,
                    )
                    assistant_provider_items = assistant_provider_items_from_history_slice(
                        session.agent.history[agent_history_start:]
                    )
                    tool_events_payload = [serialize_tool_event(event) for event in tool_events]
                    assistant_blocks = blocks_from_text_and_tools(
                        "assistant",
                        answer,
                        tool_events_payload,
                    )
                    display_answer = message_blocks_to_text(assistant_blocks)
                    if not display_answer and not message_blocks_have_reasoning(assistant_blocks):
                        display_answer = sanitize_text(answer)
                    self.app_state.append_turn(
                        session,
                        user_message=message,
                        answer=display_answer,
                        tool_events=tool_events,
                        assistant_blocks=assistant_blocks,
                        assistant_provider_items=assistant_provider_items,
                        user_attachments=transcript_attachments,
                    )
                    self.app_state.schedule_context_review(session)
                    self._send_json(
                        {
                            "answer": display_answer,
                            "tool_events": tool_events_payload,
                            "blocks": assistant_blocks,
                            "session": self.app_state.session_payload(session),
                            "context_input": sanitize_value(session.context_input),
                            **self.app_state.sidebar_payload(),
                        }
                    )
                finally:
                    self.app_state.record_agent_usage(session, "main")
                    self.app_state.release_session_request(session, "main", request_id)
                return

            self._send_error_json(HTTPStatus.NOT_FOUND, "route not found")
        except ValueError as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:  # noqa: BLE001
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, sanitize_text(str(exc) or "鏈嶅姟寮傚父"))

    def _serve_static(self, request_path: str) -> None:
        normalized_path = request_path or "/"
        if normalized_path in {"/", "/react", "/react/", "/react/index.html"}:
            file_path = self._resolve_react_asset("index.html")
            if file_path is None:
                return
        elif normalized_path.startswith("/react/"):
            react_relative_path = normalized_path.removeprefix("/react/")
            file_path = self._resolve_react_asset(react_relative_path)
            if file_path is None:
                return
        elif normalized_path.startswith(f"/{ATTACHMENTS_ROUTE}/"):
            file_path = resolve_attachment_file_path(normalized_path)
            if file_path is None:
                self._send_error_json(HTTPStatus.FORBIDDEN, "涓嶅厑璁歌闂璺緞")
                return
        else:
            relative_path = normalized_path.lstrip("/")
            file_path = (REPO_ROOT / relative_path).resolve()
            if REPO_ROOT not in file_path.parents and file_path != REPO_ROOT:
                self._send_error_json(HTTPStatus.FORBIDDEN, "涓嶅厑璁歌闂璺緞")
                return

        if not file_path.exists() or not file_path.is_file():
            self._send_error_json(HTTPStatus.NOT_FOUND, "file not found")
            return

        content = file_path.read_bytes()
        mime_type = mimetypes.guess_type(file_path.name)[0] or "text/plain; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _resolve_react_asset(self, relative_path: str) -> Path | None:
        if not REACT_DIST_DIR.exists():
            self._send_error_json(
                HTTPStatus.NOT_FOUND,
                "React build not found. Run npm run build:react first.",
            )
            return None

        safe_relative_path = relative_path.strip("/") or "index.html"
        candidate = (REACT_DIST_DIR / safe_relative_path).resolve()
        if REACT_DIST_DIR not in candidate.parents and candidate != REACT_DIST_DIR:
            self._send_error_json(HTTPStatus.FORBIDDEN, "Forbidden path")
            return None

        if candidate.exists() and candidate.is_file():
            return candidate

        fallback_index = REACT_DIST_DIR / "index.html"
        if not Path(safe_relative_path).suffix and fallback_index.exists():
            return fallback_index

        self._send_error_json(HTTPStatus.NOT_FOUND, "React asset not found")
        return None

    def _start_stream_response(self) -> None:
        self.close_connection = True
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

    def _write_stream_event(self, payload: dict[str, object]) -> None:
        body = f"{json.dumps(payload, ensure_ascii=False)}\n".encode("utf-8")
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise ClientDisconnectedError() from exc

    def _read_json_body(self) -> dict[str, object]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_length)
        except ValueError as exc:
            raise ValueError("Content-Length 闈炴硶") from exc

        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("璇锋眰浣撲笉鏄悎娉?JSON") from exc

        if not isinstance(payload, dict):
            raise ValueError("璇锋眰浣撳繀椤绘槸 JSON 瀵硅薄")
        return payload

    def _send_json(self, payload: dict[str, object], *, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": sanitize_text(message)}, status=status)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


class HashHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], app_state: AppState) -> None:
        super().__init__(server_address, HashHTTPRequestHandler)
        self.app_state = app_state


def main() -> None:
    load_dotenv(REPO_ROOT / ".env")
    settings = load_settings()
    port = int(os.getenv("HASH_WEB_PORT", "8765"))
    host = os.getenv("HASH_WEB_HOST", "127.0.0.1")
    app_state = AppState(settings)
    server = HashHTTPServer((host, port), app_state)

    print(f"hash-code web ready: http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
