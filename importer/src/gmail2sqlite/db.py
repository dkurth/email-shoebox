"""SQLite schema and writes. The schema is the contract with the web interface; see SCHEMA.md."""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

from . import __version__
from .parse import SEARCH_TEXT_MAX_CHARS, html_to_text

SCHEMA_VERSION = 2
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
  errors         INTEGER NOT NULL DEFAULT 0,
  kept_local     INTEGER NOT NULL DEFAULT 0,
  deleted_skipped INTEGER NOT NULL DEFAULT 0
);

-- Messages deleted on purpose (e.g. "Empty Trash" in a viewer). Imports skip these IDs.
CREATE TABLE IF NOT EXISTS deleted_messages (
  gmail_id   TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
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
  import_id       INTEGER REFERENCES imports(id),
  labels_edited_at INTEGER   -- set by a viewer when it changes labels; imports then keep them
);
-- (thread_id, date): groups messages into threads without reading the wide message rows.
CREATE INDEX IF NOT EXISTS messages_thread_date ON messages(thread_id, received_utc, date_utc);
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
  contentless_delete = 1,
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
    rebuild_fts = False
    if version == 1:
        print("Upgrading database to schema version 2 (rebuilding the search index)...", file=sys.stderr)
        conn.execute("BEGIN")
        # v1's contentless index can't delete rows; v2 adds contentless_delete=1.
        conn.execute("DROP TABLE IF EXISTS messages_fts")
        conn.execute("ALTER TABLE messages ADD COLUMN labels_edited_at INTEGER")
        conn.execute("ALTER TABLE imports ADD COLUMN kept_local INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE imports ADD COLUMN deleted_skipped INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE messages SET thread_id = gmail_id WHERE thread_id IS NULL")
        conn.execute("COMMIT")
        rebuild_fts = True
    conn.executescript("BEGIN;" + SCHEMA + "COMMIT;")
    conn.execute("DROP INDEX IF EXISTS messages_thread")  # replaced by messages_thread_date
    if rebuild_fts:
        rebuild_fts_index(conn)
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
                   unchanged=?, skipped=?, errors=?, kept_local=?, deleted_skipped=? WHERE id=?""",
            (
                status,
                int(time.time()) if finished else None,
                counts["seen"],
                counts["inserted"],
                counts["labels_changed"],
                counts["unchanged"],
                counts["skipped"],
                counts["errors"],
                counts["kept_local"],
                counts["deleted_skipped"],
                import_id,
            ),
        )

    # -- messages
    def find_message(self, gmail_id: str) -> sqlite3.Row | None:
        """Return (id, labels_edited_at) for a stored message, or None."""
        return self.conn.execute("SELECT id, labels_edited_at FROM messages WHERE gmail_id = ?", (gmail_id,)).fetchone()

    def deleted_ids(self) -> set[str]:
        return {r[0] for r in self.conn.execute("SELECT gmail_id FROM deleted_messages")}

    def clear_local_edit(self, message_id: int) -> None:
        self.conn.execute("UPDATE messages SET labels_edited_at = NULL WHERE id = ?", (message_id,))

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


def fts_people(from_name: str | None, from_addr: str | None, recipients: list[tuple[str, str]]) -> str:
    """The `people` column of messages_fts: names and addresses from From/To/Cc/Bcc."""
    parts = []
    if from_name or from_addr:
        parts.append(f"{from_name or ''} {from_addr or ''}".strip())
    parts += [f"{n} {a}".strip() for n, a in recipients]
    return " ".join(parts)


def fts_body(body_text: str | None, body_html: str | None) -> str:
    """The `body` column of messages_fts: plain text, or text extracted from HTML."""
    plain = body_text or (html_to_text(body_html) if body_html else "")
    return plain[:SEARCH_TEXT_MAX_CHARS]


def rebuild_fts_index(conn: sqlite3.Connection) -> None:
    """Refill messages_fts from the messages and attachments tables (no mbox needed)."""
    conn.execute("BEGIN")
    conn.execute("DELETE FROM messages_fts")
    names: dict[int, list[str]] = {}
    for mid, fn in conn.execute("SELECT message_id, filename FROM attachments WHERE filename IS NOT NULL ORDER BY message_id, part_index"):
        names.setdefault(mid, []).append(fn)
    rows = conn.execute(
        "SELECT id, subject, from_name, from_addr, to_json, cc_json, bcc_json, body_text, body_html FROM messages"
    )
    insert = "INSERT INTO messages_fts(rowid, subject, people, body, attachment_names) VALUES (?, ?, ?, ?, ?)"
    for r in rows:
        recipients = []
        for col in (r[4], r[5], r[6]):
            recipients += [(a.get("name", ""), a.get("addr", "")) for a in json.loads(col or "[]")]
        conn.execute(
            insert,
            (r[0], r[1] or "", fts_people(r[2], r[3], recipients), fts_body(r[7], r[8]), " ".join(names.get(r[0], []))),
        )
    conn.execute("COMMIT")
