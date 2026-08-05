from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

import web_server
from web_server import (
    AppState,
    SessionState,
    context_transcript_fingerprint,
    generate_context_review,
)
from web_server_modules.context_workbench import ContextWorkbenchDraft


class InMemoryAppState(AppState):
    def __init__(self) -> None:
        self.settings = SimpleNamespace(
            context_review_auto_enabled=True,
            context_review_interval_minutes=10,
        )
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


def make_record(role: str, text: str) -> dict[str, object]:
    return {
        "role": role,
        "text": text,
        "attachments": [],
        "toolEvents": [],
        "blocks": [{"kind": "text", "text": text}],
        "providerItems": [{"type": "message", "role": role, "content": text}],
    }


def make_session() -> SessionState:
    transcript = [
        make_record("user", "Original request"),
        make_record("assistant", "Verbose investigation"),
        make_record("user", "Final decision"),
    ]
    return SessionState(
        session_id="review-session",
        title="Review session",
        scope="chat",
        project_id=None,
        agent=SimpleNamespace(settings=SimpleNamespace(default_reasoning_effort=None)),
        transcript=transcript,
        context_input=[],
        context_workbench_history=[],
        context_revisions=[],
        pending_context_restore=None,
        pending_context_review=None,
        usage_summary={},
    )


def proposed_transcript() -> list[dict[str, object]]:
    return [
        make_record("user", "Original request and final decision"),
        make_record("assistant", "Concise investigation"),
    ]


def make_review(session: SessionState) -> dict[str, object]:
    return {
        "id": "review-1",
        "session_id": session.session_id,
        "source": "manual",
        "summary": "合并重复背景并保留最终决定。",
        "base_context_fingerprint": context_transcript_fingerprint(session.transcript),
        "before": {"node_count": 3, "token_count": 12},
        "after": {"node_count": 2, "token_count": 8},
        "proposed_transcript": proposed_transcript(),
        "operations": [
            {
                "operation_type": "write_nodes",
                "change_type": "compress",
                "changed_nodes": [1, 3],
            }
        ],
    }


def test_apply_review_creates_revision_and_restore_returns_to_original() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    original_texts = [record["text"] for record in session.transcript]
    app_state.store_context_review(session, make_review(session))

    conversation, revisions, pending_restore = app_state.apply_context_review(session, "review-1")

    assert [record["text"] for record in conversation] == [
        "Original request and final decision",
        "Concise investigation",
    ]
    assert pending_restore is None
    assert [revision["revision_number"] for revision in revisions] == [1, 0]
    assert revisions[0]["is_active"] is True
    assert revisions[0]["summary"] == "合并重复背景并保留最终决定。"

    revision_zero = next(
        revision for revision in session.context_revisions if revision["revision_number"] == 0
    )
    restored, _, _, undo = app_state.restore_context_revision(
        session,
        str(revision_zero["id"]),
    )
    assert [record["text"] for record in restored] == original_texts
    assert undo is not None


def test_apply_rejects_and_discards_review_when_context_changed() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    app_state.store_context_review(session, make_review(session))
    session.transcript.append(make_record("assistant", "Newer answer"))

    with pytest.raises(ValueError, match="建议已经过期"):
        app_state.apply_context_review(session, "review-1")

    assert session.pending_context_review is None
    assert session.transcript[-1]["text"] == "Newer answer"
    assert session.context_revisions == []


def test_discard_review_does_not_change_transcript() -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    original = list(session.transcript)
    app_state.store_context_review(session, make_review(session))

    app_state.discard_context_review(session, "review-1")

    assert session.pending_context_review is None
    assert session.transcript == original
    assert session.context_revisions == []


def test_no_change_review_is_not_persisted(monkeypatch: pytest.MonkeyPatch) -> None:
    app_state = InMemoryAppState()
    session = make_session()
    app_state.sessions[session.session_id] = session
    draft = ContextWorkbenchDraft(session.transcript, selected_indexes=[])

    monkeypatch.setattr(
        web_server,
        "run_context_chat_turn",
        lambda *args, **kwargs: ("NO_CHANGE", "test-model", draft, [], []),
    )

    assert generate_context_review(app_state, session) is None
    assert session.pending_context_review is None


def test_auto_review_request_is_registered_atomically() -> None:
    app_state = InMemoryAppState()
    session = make_session()

    request_id = app_state.acquire_session_request(
        session,
        "context",
        auto_context_review=True,
    )

    assert request_id in app_state._auto_review_request_ids
    assert app_state.cancel_auto_context_review(session) is True
    assert session.active_cancel_event is not None
    assert session.active_cancel_event.is_set()

    app_state.release_session_request(session, "context", request_id)
    assert request_id not in app_state._auto_review_request_ids
