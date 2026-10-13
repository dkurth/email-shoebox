"""Schema v3: thread notes with search, message addresses, mailing lists, deleted attachment files."""

import sqlite3
import time

from build_fixtures import downgrade_to_v2, mbox_bytes, simple_message

from gmail2sqlite import db
from gmail2sqlite.importer import ImportOptions, run_import
from gmail2sqlite.parse import list_id_from_headers, parse_list_id


def _setup(tmp_path):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(
        mbox_bytes(
            [
                ("21", simple_message(subject="hello", to="Bob <bob@example.com>, carol@example.com",
                                      extra_headers={"Cc": "Dana <DANA@example.com>", "Bcc": "eve@example.com"},
                                      attachments=[("x.txt", "text/plain", b"x")])),
                ("22", simple_message(subject="list mail", thread_id="1000000000000000022",
                                      extra_headers={"List-Id": "Announcements <Announce.Lists.Example.ORG>"})),
            ]
        )
    )
    out = tmp_path / "out"
    run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    return mbox, out


def _conn(out):
    c = sqlite3.connect(out / "mail.db")
    c.execute("PRAGMA foreign_keys = ON")
    return c


def _addresses(c, gmail_id):
    return sorted(tuple(r) for r in c.execute(
        "SELECT role, addr, name FROM message_addresses a JOIN messages m ON m.id = a.message_id WHERE m.gmail_id = ?",
        (gmail_id,)).fetchall())


def test_addresses_are_stored(tmp_path):
    _, out = _setup(tmp_path)
    assert _addresses(_conn(out), "21") == [
        ("bcc", "eve@example.com", ""),
        ("cc", "dana@example.com", "Dana"),
        ("from", "alice@example.com", "Alice Example"),
        ("to", "bob@example.com", "Bob"),
        ("to", "carol@example.com", ""),
    ]


def test_addresses_cascade_on_delete(tmp_path):
    _, out = _setup(tmp_path)
    c = _conn(out)
    c.execute("DELETE FROM messages_fts WHERE rowid = (SELECT id FROM messages WHERE gmail_id = '21')")
    c.execute("DELETE FROM messages WHERE gmail_id = '21'")
    assert c.execute("SELECT count(*) FROM message_addresses").fetchone()[0] == 2  # message 22: from and to


def test_list_id_is_stored(tmp_path):
    _, out = _setup(tmp_path)
    rows = _conn(out).execute("SELECT gmail_id, list_id, list_name FROM messages ORDER BY gmail_id").fetchall()
    assert rows == [("21", None, None), ("22", "announce.lists.example.org", "Announcements")]


def test_parse_list_id():
    assert parse_list_id("Announcements <Announce.Lists.Example.ORG>") == ("announce.lists.example.org", "Announcements")
    assert parse_list_id('"Quoted Name" <q.example.com>') == ("q.example.com", "Quoted Name")
    assert parse_list_id("<only.id.example.com>") == ("only.id.example.com", None)
    assert parse_list_id("  no.brackets.example.com ") == ("no.brackets.example.com", None)
    assert parse_list_id("=?utf-8?q?Gr=C3=BC=C3=9Fe?= <gruesse.example.de>") == ("gruesse.example.de", "Grüße")
    assert parse_list_id("Folded\n name <f.example.com>") == ("f.example.com", "Folded name")
    assert parse_list_id("") == (None, None)
    assert parse_list_id("Name <>") == (None, None)
    assert parse_list_id(None) == (None, None)
    headers = "From: a@b.c\nLIST-ID: Upper\n <u.example.com>\nSubject: x\n"
    assert list_id_from_headers(headers) == ("u.example.com", "Upper")
    assert list_id_from_headers("From: a@b.c\n") == (None, None)


def test_notes_search_follows_every_change(tmp_path):
    _, out = _setup(tmp_path)
    c = _conn(out)
    now = int(time.time() * 1000)

    def hits(q):
        return c.execute("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH ?", (q,)).fetchone()[0]

    c.execute("INSERT INTO thread_notes(thread_id, body, created_at, updated_at) VALUES ('t1', 'call the café', ?, ?)", (now, now))
    assert hits("cafe") == 1  # remove_diacritics
    c.execute("UPDATE thread_notes SET body = 'email the landlord', updated_at = ? WHERE thread_id = 't1'", (now + 1,))
    assert (hits("cafe"), hits("landlord")) == (0, 1)
    c.execute("DELETE FROM thread_notes WHERE thread_id = 't1'")
    assert hits("landlord") == 0
    c.execute("INSERT INTO notes_fts(notes_fts) VALUES ('integrity-check')")  # raises if the index is wrong


def test_reimport_keeps_notes_and_deleted_attachments(tmp_path):
    mbox, out = _setup(tmp_path)
    c = _conn(out)
    now = int(time.time() * 1000)
    c.execute("INSERT INTO thread_notes(thread_id, body, created_at, updated_at) VALUES ('1000000000000000001', 'mine', ?, ?)", (now, now))
    path = c.execute("SELECT path FROM attachments").fetchone()[0]
    c.execute("UPDATE attachments SET deleted_at = ?", (int(time.time()),))
    c.commit()
    (out / path).unlink()

    res = run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    assert res.counts["inserted"] == 0
    assert c.execute("SELECT body FROM thread_notes").fetchall() == [("mine",)]
    assert c.execute("SELECT deleted_at IS NOT NULL FROM attachments").fetchone()[0] == 1
    assert not (out / path).exists()  # the file is not written again
    assert c.execute("SELECT count(*) FROM message_addresses").fetchone()[0] == 7  # not doubled


def test_v2_archive_upgrades(tmp_path):
    _, out = _setup(tmp_path)
    downgrade_to_v2(out / "mail.db")
    conn = db.connect(out)
    assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "3"
    assert _addresses(conn, "21")[0] == ("bcc", "eve@example.com", "")
    assert conn.execute("SELECT count(*) FROM message_addresses").fetchone()[0] == 7
    assert tuple(conn.execute("SELECT list_id, list_name FROM messages WHERE gmail_id = '22'").fetchone()) == (
        "announce.lists.example.org", "Announcements")
    assert conn.execute("SELECT count(*) FROM attachments WHERE deleted_at IS NULL").fetchone()[0] == 1
    conn.execute("SELECT count(*) FROM thread_notes").fetchone()
    conn.close()
    # Opening it again changes nothing.
    conn = db.connect(out)
    assert conn.execute("SELECT count(*) FROM message_addresses").fetchone()[0] == 7
    conn.close()
