"""Schema v2: deletions stick, local label edits win, FTS rows can be deleted, v1 archives upgrade."""

import sqlite3
import time

from build_fixtures import mbox_bytes, simple_message

from gmail2sqlite import db
from gmail2sqlite.importer import ImportOptions, run_import


def _setup(tmp_path):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(
        mbox_bytes(
            [
                ("11", simple_message(subject="keep me", body="alpha words\n", labels="Inbox")),
                ("12", simple_message(subject="delete me", body="bravo words\n", labels="Trash", thread_id=None,
                                      attachments=[("x.txt", "text/plain", b"x")])),
            ]
        )
    )
    out = tmp_path / "out"
    run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    return mbox, out


def _conn(out):
    c = sqlite3.connect(out / "mail.db")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")  # per connection; needed for ON DELETE CASCADE
    return c


def test_missing_thread_id_uses_gmail_id(tmp_path):
    _, out = _setup(tmp_path)
    assert _conn(out).execute("SELECT thread_id FROM messages WHERE gmail_id='12'").fetchone()[0] == "12"


def test_deleted_messages_are_not_reimported(tmp_path):
    mbox, out = _setup(tmp_path)
    c = _conn(out)
    mid = c.execute("SELECT id FROM messages WHERE gmail_id='12'").fetchone()[0]
    c.execute("INSERT INTO deleted_messages VALUES ('12', ?)", (int(time.time()),))
    c.execute("DELETE FROM messages_fts WHERE rowid = ?", (mid,))  # works with contentless_delete=1
    c.execute("DELETE FROM messages WHERE id = ?", (mid,))
    c.commit()
    assert c.execute("SELECT count(*) FROM attachments").fetchone()[0] == 0  # cascaded
    res = run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    assert res.counts["deleted_skipped"] == 1 and res.counts["inserted"] == 0
    assert c.execute("SELECT count(*) FROM messages").fetchone()[0] == 1
    assert c.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'bravo'").fetchone()[0] == 0


def test_local_label_edits_survive_reimport(tmp_path):
    mbox, out = _setup(tmp_path)
    c = _conn(out)
    mid = c.execute("SELECT id FROM messages WHERE gmail_id='11'").fetchone()[0]
    c.execute("INSERT OR IGNORE INTO labels(name) VALUES ('Archived')")
    c.execute("DELETE FROM message_labels WHERE message_id = ?", (mid,))
    c.execute("INSERT INTO message_labels SELECT ?, id FROM labels WHERE name='Archived'", (mid,))
    c.execute("UPDATE messages SET labels_edited_at = 1 WHERE id = ?", (mid,))
    c.commit()

    def names():
        return {r[0] for r in c.execute(
            "SELECT l.name FROM message_labels ml JOIN labels l ON l.id=ml.label_id WHERE ml.message_id=?", (mid,))}

    res = run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    assert res.counts["kept_local"] == 1
    assert names() == {"Archived"}
    res = run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True, overwrite_local_labels=True))
    assert names() == {"Inbox"}
    assert c.execute("SELECT labels_edited_at FROM messages WHERE id=?", (mid,)).fetchone()[0] is None


def test_v1_archive_upgrades(tmp_path):
    _, out = _setup(tmp_path)
    c = _conn(out)
    # Turn this archive back into a v1 archive.
    c.executescript(
        """
        DROP TABLE messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(subject, people, body, attachment_names, content='',
          tokenize='unicode61 remove_diacritics 2');
        INSERT INTO messages_fts(rowid, subject, people, body, attachment_names) SELECT id, subject, '', '', '' FROM messages;
        DROP TABLE deleted_messages;
        ALTER TABLE messages DROP COLUMN labels_edited_at;
        ALTER TABLE imports DROP COLUMN kept_local;
        ALTER TABLE imports DROP COLUMN deleted_skipped;
        UPDATE messages SET thread_id = NULL WHERE gmail_id = '12';
        UPDATE meta SET value = '1' WHERE key = 'schema_version';
        """
    )
    c.close()
    conn = db.connect(out)
    assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "2"
    assert "contentless_delete" in conn.execute("SELECT sql FROM sqlite_master WHERE name='messages_fts'").fetchone()[0]
    # The index was rebuilt from stored bodies, people and attachment names.
    for q, n in (("alpha", 1), ("bravo", 1), ("people:alice", 2), ("attachment_names:x", 1)):
        assert conn.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?", (q,)).fetchone()[0] == n, q
    assert conn.execute("SELECT thread_id FROM messages WHERE gmail_id='12'").fetchone()[0] == "12"
    conn.execute("SELECT labels_edited_at FROM messages").fetchall()
    conn.execute("SELECT count(*) FROM deleted_messages").fetchone()
    conn.close()
