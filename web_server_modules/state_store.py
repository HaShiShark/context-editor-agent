from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "3"


class SQLiteStateStore:
    """Persist the app state in SQLite while keeping the existing JSON payload contract."""

    def __init__(self, db_file: Path, legacy_json_file: Path | None = None) -> None:
        self.db_file = db_file
        self.legacy_json_file = legacy_json_file

    def load_state(self) -> dict[str, Any]:
        self._ensure_schema()
        with self._connect() as connection:
            if self._has_state(connection):
                return self._load_from_db(connection)

        legacy_state = self._load_legacy_json()
        if legacy_state:
            self.save_state(legacy_state)
            return legacy_state
        return {}

    def save_state(self, payload: dict[str, Any]) -> None:
        self._ensure_schema()
        projects = payload.get("projects") if isinstance(payload, dict) else []
        chat_session_ids = payload.get("chat_session_ids") if isinstance(payload, dict) else []
        sessions = payload.get("sessions") if isinstance(payload, dict) else {}

        with self._connect() as connection:
            connection.execute("BEGIN")
            connection.execute("DELETE FROM metadata")
            connection.execute("DELETE FROM project_session_order")
            connection.execute("DELETE FROM chat_session_order")
            connection.execute("DELETE FROM projects")
            connection.execute("DELETE FROM sessions")

            connection.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?)",
                ("schema_version", SCHEMA_VERSION),
            )

            if isinstance(projects, list):
                for sort_order, project in enumerate(projects):
                    if not isinstance(project, dict):
                        continue
                    project_id = _clean_text(project.get("id"))
                    if not project_id:
                        continue
                    connection.execute(
                        """
                        INSERT INTO projects(id, title, root_path, sort_order)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            project_id,
                            _clean_text(project.get("title")),
                            _clean_text(project.get("root_path")),
                            sort_order,
                        ),
                    )
                    self._save_project_session_order(
                        connection,
                        project_id,
                        "active",
                        project.get("session_ids"),
                    )
                    self._save_project_session_order(
                        connection,
                        project_id,
                        "archived",
                        project.get("archived_session_ids"),
                    )

            if isinstance(chat_session_ids, list):
                for sort_order, session_id in enumerate(chat_session_ids):
                    safe_session_id = _clean_text(session_id)
                    if not safe_session_id:
                        continue
                    connection.execute(
                        """
                        INSERT INTO chat_session_order(session_id, sort_order)
                        VALUES (?, ?)
                        """,
                        (safe_session_id, sort_order),
                    )

            if isinstance(sessions, dict):
                for session_id, session in sessions.items():
                    if not isinstance(session, dict):
                        continue
                    safe_session_id = _clean_text(session_id)
                    if not safe_session_id:
                        continue
                    connection.execute(
                        """
                        INSERT INTO sessions(
                            id,
                            title,
                            scope,
                            project_id,
                            transcript_json,
                            context_workbench_history_json,
                            context_revisions_json,
                            pending_context_restore_json,
                            pending_context_review_json,
                            usage_summary_json
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            safe_session_id,
                            _clean_text(session.get("title")),
                            _clean_text(session.get("scope")),
                            _clean_text(session.get("project_id")),
                            _json_dumps(session.get("transcript", [])),
                            _json_dumps(session.get("context_workbench_history", [])),
                            _json_dumps(session.get("context_revisions", [])),
                            _json_dumps(session.get("pending_context_restore")),
                            _json_dumps(session.get("pending_context_review")),
                            _json_dumps(session.get("usage_summary", {})),
                        ),
                    )

            connection.commit()

    def _save_project_session_order(
        self,
        connection: sqlite3.Connection,
        project_id: str,
        list_type: str,
        session_ids: Any,
    ) -> None:
        if not isinstance(session_ids, list):
            return
        for sort_order, session_id in enumerate(session_ids):
            safe_session_id = _clean_text(session_id)
            if not safe_session_id:
                continue
            connection.execute(
                """
                INSERT INTO project_session_order(project_id, session_id, list_type, sort_order)
                VALUES (?, ?, ?, ?)
                """,
                (project_id, safe_session_id, list_type, sort_order),
            )

    def _load_from_db(self, connection: sqlite3.Connection) -> dict[str, Any]:
        project_session_rows = connection.execute(
            """
            SELECT project_id, session_id, list_type
            FROM project_session_order
            ORDER BY sort_order ASC
            """
        ).fetchall()
        project_sessions: dict[str, dict[str, list[str]]] = {}
        for row in project_session_rows:
            lists = project_sessions.setdefault(row["project_id"], {"active": [], "archived": []})
            list_type = row["list_type"] if row["list_type"] in lists else "active"
            lists[list_type].append(row["session_id"])

        projects = []
        for row in connection.execute(
            """
            SELECT id, title, root_path
            FROM projects
            ORDER BY sort_order ASC
            """
        ):
            lists = project_sessions.get(row["id"], {"active": [], "archived": []})
            projects.append(
                {
                    "id": row["id"],
                    "title": row["title"] or "",
                    "session_ids": lists["active"],
                    "archived_session_ids": lists["archived"],
                    "root_path": row["root_path"] or "",
                }
            )

        chat_session_ids = [
            row["session_id"]
            for row in connection.execute(
                """
                SELECT session_id
                FROM chat_session_order
                ORDER BY sort_order ASC
                """
            )
        ]

        sessions = {}
        for row in connection.execute(
            """
            SELECT
                id,
                title,
                scope,
                project_id,
                transcript_json,
                context_workbench_history_json,
                context_revisions_json,
                pending_context_restore_json,
                pending_context_review_json,
                usage_summary_json
            FROM sessions
            """
        ):
            project_id = row["project_id"] or None
            sessions[row["id"]] = {
                "title": row["title"] or "",
                "scope": row["scope"] or "chat",
                "project_id": project_id,
                "transcript": _json_loads(row["transcript_json"], []),
                "context_workbench_history": _json_loads(row["context_workbench_history_json"], []),
                "context_revisions": _json_loads(row["context_revisions_json"], []),
                "pending_context_restore": _json_loads(row["pending_context_restore_json"], None),
                "pending_context_review": _json_loads(row["pending_context_review_json"], None),
                "usage_summary": _json_loads(row["usage_summary_json"], {}),
            }

        return {
            "projects": projects,
            "chat_session_ids": chat_session_ids,
            "sessions": sessions,
        }

    def _load_legacy_json(self) -> dict[str, Any]:
        if self.legacy_json_file is None or not self.legacy_json_file.exists():
            return {}
        try:
            raw_state = json.loads(self.legacy_json_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw_state if isinstance(raw_state, dict) else {}

    def _ensure_schema(self) -> None:
        self.db_file.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;

                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    root_path TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    project_id TEXT,
                    transcript_json TEXT NOT NULL,
                    context_workbench_history_json TEXT NOT NULL,
                    context_revisions_json TEXT NOT NULL,
                    pending_context_restore_json TEXT NOT NULL,
                    pending_context_review_json TEXT NOT NULL DEFAULT 'null',
                    usage_summary_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS chat_session_order (
                    session_id TEXT PRIMARY KEY,
                    sort_order INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS project_session_order (
                    project_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    list_type TEXT NOT NULL CHECK(list_type IN ('active', 'archived')),
                    sort_order INTEGER NOT NULL,
                    PRIMARY KEY(project_id, session_id, list_type)
                );
                """
            )
            session_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(sessions)")
            }
            if "pending_context_review_json" not in session_columns:
                connection.execute(
                    "ALTER TABLE sessions ADD COLUMN pending_context_review_json TEXT NOT NULL DEFAULT 'null'"
                )
            if "usage_summary_json" not in session_columns:
                connection.execute(
                    "ALTER TABLE sessions ADD COLUMN usage_summary_json TEXT NOT NULL DEFAULT '{}'"
                )

    def _has_state(self, connection: sqlite3.Connection) -> bool:
        for table_name in ("projects", "sessions", "chat_session_order", "project_session_order"):
            row = connection.execute(f"SELECT 1 FROM {table_name} LIMIT 1").fetchone()
            if row is not None:
                return True
        return False

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_file)
        connection.row_factory = sqlite3.Row
        return connection


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _json_loads(value: str | None, fallback: Any) -> Any:
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback
