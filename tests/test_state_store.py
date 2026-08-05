import json
import sqlite3

from web_server_modules.state_store import SQLiteStateStore


def sample_state() -> dict[str, object]:
    return {
        "projects": [
            {
                "id": "project-1",
                "title": "Demo",
                "session_ids": ["session-project"],
                "archived_session_ids": ["session-archived"],
                "root_path": "C:\\work\\demo",
            }
        ],
        "chat_session_ids": ["session-chat"],
        "sessions": {
            "session-chat": {
                "title": "Chat",
                "scope": "chat",
                "project_id": None,
                "transcript": [{"role": "user", "text": "hello"}],
                "context_workbench_history": [],
                "context_revisions": [{"id": "rev-1", "label": "Initial"}],
                "pending_context_restore": None,
                "pending_context_review": {
                    "id": "review-1",
                    "base_context_fingerprint": "fingerprint",
                    "proposed_transcript": [{"role": "user", "text": "hello, condensed"}],
                },
                "usage_summary": {
                    "request_count": 1,
                    "input_tokens": 10,
                    "output_tokens": 2,
                    "total_tokens": 12,
                },
            },
            "session-project": {
                "title": "Project Chat",
                "scope": "project",
                "project_id": "project-1",
                "transcript": [{"role": "assistant", "text": "done"}],
                "context_workbench_history": [{"role": "user", "content": "trim"}],
                "context_revisions": [],
                "pending_context_restore": {"target_revision_id": "rev-1"},
                "pending_context_review": None,
                "usage_summary": {},
            },
            "session-archived": {
                "title": "Archived",
                "scope": "project",
                "project_id": "project-1",
                "transcript": [],
                "context_workbench_history": [],
                "context_revisions": [],
                "pending_context_restore": None,
                "pending_context_review": None,
                "usage_summary": {},
            },
        },
    }


def test_state_store_migrates_legacy_json_to_sqlite(tmp_path):
    legacy_json = tmp_path / "hash_web_state.json"
    db_file = tmp_path / "hash_web_state.sqlite3"
    legacy_json.write_text(json.dumps(sample_state(), ensure_ascii=False), encoding="utf-8")

    store = SQLiteStateStore(db_file, legacy_json_file=legacy_json)

    assert store.load_state() == sample_state()
    assert db_file.exists()

    with sqlite3.connect(db_file) as connection:
        project_count = connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]

    assert project_count == 1
    assert session_count == 3


def test_state_store_round_trips_state_through_sqlite(tmp_path):
    db_file = tmp_path / "hash_web_state.sqlite3"
    store = SQLiteStateStore(db_file)

    store.save_state(sample_state())

    reloaded_store = SQLiteStateStore(db_file)
    assert reloaded_store.load_state() == sample_state()


def test_state_store_adds_pending_review_column_to_existing_database(tmp_path):
    db_file = tmp_path / "hash_web_state.sqlite3"
    with sqlite3.connect(db_file) as connection:
        connection.executescript(
            """
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                root_path TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL
            );
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                scope TEXT NOT NULL,
                project_id TEXT,
                transcript_json TEXT NOT NULL,
                context_workbench_history_json TEXT NOT NULL,
                context_revisions_json TEXT NOT NULL,
                pending_context_restore_json TEXT NOT NULL
            );
            CREATE TABLE chat_session_order (session_id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL);
            CREATE TABLE project_session_order (
                project_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                list_type TEXT NOT NULL CHECK(list_type IN ('active', 'archived')),
                sort_order INTEGER NOT NULL,
                PRIMARY KEY(project_id, session_id, list_type)
            );
            """
        )

    SQLiteStateStore(db_file).load_state()

    with sqlite3.connect(db_file) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    assert "pending_context_review_json" in columns
    assert "usage_summary_json" in columns
