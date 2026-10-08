"""SQLite schema and writes. The schema is the contract with the web interface; see SCHEMA.md."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from . import __version__

SCHEMA_VERSION = 1
DB_FILENAME = "mail.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id             INTEGER PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  status         TEXT NOT NULL DEFAULT 'running',   -- running | finished | interrupted | failed
  sources_json   TEXT NOT NULL,
  tool_version   TEXT,
  messages_seen  INTEGER NOT NULL DEFAULT 0,
  inserted       INTEGER NOT NULL DEFAULT 0,
  labels_changed INTEGER NOT NULL DEFAULT 0,
  unchanged      INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  gmail_id        TEXT NOT NULL UNIQUE,
  thread_id       TEXT,
  message_id      TEXT,
  in_reply_to     TEXT,
  references_hdr  TEXT,
  subject         TEXT,
  from_name       TEXT,
  from_addr       TEXT,
  to_json         TEXT,
  cc_json         TEXT,
  bcc_json        TEXT,
  reply_to_json   TEXT,
  date_utc        INTEGER,
  date_raw        TEXT,
  received_utc    INTEGER,
  snippet         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  headers_raw     TEXT,
  size_bytes      INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_unread       INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  is_important    INTEGER NOT NULL DEFAULT 0,
  parse_error     TEXT,
  import_id       INTEGER REFERENCES imports(id)
);
CREATE INDEX IF NOT EXISTS messages_thread   ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_received ON messages(received_utc);
CREATE INDEX IF NOT EXISTS messages_date     ON messages(date_utc);
CREATE INDEX IF NOT EXISTS messages_from     ON messages(from_addr);
CREATE INDEX IF NOT EXISTS messages_msgid    ON messages(message_id);

CREATE TABLE IF NOT EXISTS labels (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (message_id, label_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_labels_label ON message_labels(label_id, message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_index   INTEGER NOT NULL,
  filename     TEXT,
  path         TEXT NOT NULL,
  content_type TEXT,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  content_id   TEXT,
  is_inline    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (message_id, part_index)
);
CREATE INDEX IF NOT EXISTS attachments_sha256 ON attachments(sha256);

CREATE TABLE IF NOT EXISTS threads (
  thread_id         TEXT PRIMARY KEY,
  subject           TEXT,
  first_date        INTEGER,
  last_date         INTEGER,
  message_count     INTEGER NOT NULL,
  participants_json TEXT,
  labels_json       TEXT
);
CREATE INDEX IF NOT EXISTS threads_last_date ON threads(last_date);

-- Contentless: holds only the search index, not a second copy of the text.
-- rowid = messages.id.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, people, body, attachment_names,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- A readable list for Datasette and ad-hoc SQL.
CREATE VIEW IF NOT EXISTS message_list AS
SELECT
  m.id,
  datetime(coalesce(m.received_utc, m.date_utc), 'unixepoch') AS received,
  m.from_name,
  m.from_addr,
  m.subject,
  m.snippet,
  (SELECT group_concat(l.name, ', ')
     FROM message_labels ml JOIN labels l ON l.id = ml.label_id
    WHERE ml.message_id = m.id) AS labels,
  m.has_attachments,
  m.is_unread,
  m.is_starred,
  m.thread_id
FROM messages m;
"""


class SchemaError(Exception):
    pass


def connect(out_dir: Path) -> sqlite3.Connection:
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(out_dir / DB_FILENAME, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA cache_size = -65536")  # 64 MB
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    has_meta = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
    version = None
    if has_meta:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        version = int(row[0]) if row else None
    if version is not None and version > SCHEMA_VERSION:
        raise SchemaError(f"database schema version {version} is newer than this tool supports ({SCHEMA_VERSION})")
    # threads is derived data, rebuilt after every import; recreate it if its columns changed.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(threads)")}
    if cols and "labels_json" not in cols:
        conn.execute("DROP TABLE threads")
    conn.executescript("BEGIN;" + SCHEMA + "COMMIT;")
    # Future migrations go here: if version == 1: ...
    set_meta(conn, "schema_version", str(SCHEMA_VERSION))
    set_meta(conn, "tool_version", __version__)


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


class Writer:
    """All writes for one import. Callers wrap batches in begin()/commit()."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self._label_ids: dict[str, int] = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM labels")}

    # -- transactions
    def begin(self) -> None:
        self.conn.execute("BEGIN")

    def commit(self) -> None:
        if self.conn.in_transaction:
            self.conn.execute("COMMIT")

    def savepoint(self) -> None:
        self.conn.execute("SAVEPOINT msg")

    def release(self) -> None:
        self.conn.execute("RELEASE msg")

    def rollback_savepoint(self) -> None:
        self.conn.execute("ROLLBACK TO msg")
        self.conn.execute("RELEASE msg")

    # -- imports table
    def start_import(self, sources: list[str]) -> int:
        cur = self.conn.execute(
            "INSERT INTO imports(started_at, sources_json, tool_version) VALUES (?, ?, ?)",
            (int(time.time()), json.dumps(sources), __version__),
        )
        return cur.lastrowid

    def update_import(self, import_id: int, status: str, counts: dict[str, int], finished: bool) -> None:
        self.conn.execute(
            """UPDATE imports SET status=?, finished_at=?, messages_seen=?, inserted=?, labels_changed=?,
                   unchanged=?, skipped=?, errors=? WHERE id=?""",
            (
                status,
                int(time.time()) if finished else None,
                counts["seen"],
                counts["inserted"],
                counts["labels_changed"],
                counts["unchanged"],
                counts["skipped"],
                counts["errors"],
                import_id,
            ),
        )

    # -- messages
    def find_message(self, gmail_id: str) -> int | None:
        row = self.conn.execute("SELECT id FROM messages WHERE gmail_id = ?", (gmail_id,)).fetchone()
        return row[0] if row else None

    def insert_message(self, row: dict) -> int:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        cur = self.conn.execute(f"INSERT INTO messages ({cols}) VALUES ({marks})", tuple(row.values()))
        return cur.lastrowid

    def insert_attachment(self, row: dict) -> None:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        self.conn.execute(f"INSERT INTO attachments ({cols}) VALUES ({marks})", tuple(row.values()))

    def insert_fts(self, message_id: int, subject: str, people: str, body: str, attachment_names: str) -> None:
        self.conn.execute(
            "INSERT INTO messages_fts(rowid, subject, people, body, attachment_names) VALUES (?, ?, ?, ?, ?)",
            (message_id, subject, people, body, attachment_names),
        )

    def _label_id(self, name: str) -> int:
        lid = self._label_ids.get(name)
        if lid is None:
            self.conn.execute("INSERT OR IGNORE INTO labels(name) VALUES (?)", (name,))
            lid = self.conn.execute("SELECT id FROM labels WHERE name = ?", (name,)).fetchone()[0]
            self._label_ids[name] = lid
        return lid

    def set_labels(self, message_id: int, labels: list[str]) -> bool:
        """Replace a message's labels and the flags derived from them. Returns True if anything changed."""
        new = {self._label_id(n) for n in labels}
        old = {r[0] for r in self.conn.execute("SELECT label_id FROM message_labels WHERE message_id = ?", (message_id,))}
        if new == old:
            return False
        self.conn.executemany(
            "DELETE FROM message_labels WHERE message_id = ? AND label_id = ?", [(message_id, l) for l in old - new]
        )
        self.conn.executemany(
            "INSERT INTO message_labels(message_id, label_id) VALUES (?, ?)", [(message_id, l) for l in new - old]
        )
        names = set(labels)
        self.conn.execute(
            "UPDATE messages SET is_unread = ?, is_starred = ?, is_important = ? WHERE id = ?",
            ("Unread" in names, "Starred" in names, "Important" in names, message_id),
        )
        return True

    # -- threads
    def rebuild_threads(self) -> None:
        self.conn.execute("DELETE FROM threads")
        self.conn.execute(
            """
            INSERT INTO threads (thread_id, subject, first_date, last_date, message_count, participants_json, labels_json)
            SELECT
              m.thread_id,
              (SELECT m2.subject FROM messages m2
                WHERE m2.thread_id = m.thread_id
                ORDER BY coalesce(m2.received_utc, m2.date_utc), m2.id LIMIT 1),
              min(coalesce(m.received_utc, m.date_utc)),
              max(coalesce(m.received_utc, m.date_utc)),
              count(*),
              json_group_array(DISTINCT m.from_addr) FILTER (WHERE m.from_addr IS NOT NULL),
              (SELECT json_group_array(DISTINCT l.name) FROM messages m3
                 JOIN message_labels ml ON ml.message_id = m3.id
                 JOIN labels l ON l.id = ml.label_id
                WHERE m3.thread_id = m.thread_id)
            FROM messages m
            WHERE m.thread_id IS NOT NULL
            GROUP BY m.thread_id
            """
        )


def to_json(addresses) -> str | None:
    if not addresses:
        return None
    return json.dumps([a.as_dict() for a in addresses], ensure_ascii=False)
