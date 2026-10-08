import hashlib
import json
import sqlite3

import pytest
from build_fixtures import mbox_bytes, simple_message, write_inputs

from gmail2sqlite.cli import main
from gmail2sqlite.importer import ImportOptions, run_import


def _mailbox(labels_for_2="Inbox,Unread"):
    return mbox_bytes(
        [
            (
                "1000000000000000001",
                simple_message(
                    subject="Quarterly report",
                    body="Numbers attached, see the spreadsheet.\n",
                    sender="Alice <alice@example.com>",
                    labels="Inbox,Important",
                    thread_id="1000000000000000001",
                    attachments=[("q3 numbers.xlsx", "application/vnd.ms-excel", b"xlsx-bytes")],
                ),
            ),
            (
                "1000000000000000002",
                simple_message(
                    subject="Re: Quarterly report",
                    body="Thanks! Looks great.\nFrom the team\n",
                    sender="Bob <bob@example.com>",
                    to="Alice <alice@example.com>",
                    date="Thu, 25 Apr 2024 10:00:00 +0000",
                    labels=labels_for_2,
                    thread_id="1000000000000000001",
                    message_id="<m2@example.com>",
                ),
            ),
            (
                "1000000000000000003",
                simple_message(
                    subject="You won!!!",
                    body="Claim your prize: zanzibar\n",
                    labels="Spam",
                    thread_id="1000000000000000003",
                    message_id=None,
                ),
            ),
        ]
    )


def _db(out):
    conn = sqlite3.connect(out / "mail.db")
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture
def archive(tmp_path):
    paths = write_inputs(tmp_path / "in", _mailbox())
    out = tmp_path / "out"
    res = run_import([str(paths["tgz"])], ImportOptions(out_dir=out, quiet=True))
    return out, res, paths


def test_import_rows(archive):
    out, res, _ = archive
    assert res.status == "finished"
    assert res.counts["inserted"] == 3 and res.counts["errors"] == 0
    conn = _db(out)
    rows = conn.execute("SELECT * FROM messages ORDER BY gmail_id").fetchall()
    assert [r["subject"] for r in rows] == ["Quarterly report", "Re: Quarterly report", "You won!!!"]
    m2 = rows[1]
    assert m2["is_unread"] == 1 and m2["thread_id"] == "1000000000000000001"
    assert m2["body_text"] == "Thanks! Looks great.\nFrom the team\n"  # mbox escaping undone
    assert json.loads(m2["to_json"]) == [{"name": "Alice", "addr": "alice@example.com"}]
    assert m2["received_utc"] == 1713929042
    assert rows[2]["message_id"] is None
    assert rows[0]["is_important"] == 1 and rows[0]["has_attachments"] == 1


def test_attachment_written_and_recorded(archive):
    out, _, _ = archive
    att = _db(out).execute("SELECT * FROM attachments").fetchone()
    assert att["filename"] == "q3 numbers.xlsx"
    f = out / att["path"]
    assert f.read_bytes() == b"xlsx-bytes"
    assert att["sha256"] == hashlib.sha256(b"xlsx-bytes").hexdigest()
    assert att["path"].endswith("/1000000000000000001/01-q3 numbers.xlsx")


def test_labels_threads_and_fts(archive):
    out, _, _ = archive
    conn = _db(out)
    labels = {r[0] for r in conn.execute("SELECT name FROM labels")}
    assert labels == {"Inbox", "Important", "Unread", "Spam"}
    t = conn.execute("SELECT * FROM threads WHERE thread_id = '1000000000000000001'").fetchone()
    assert t["message_count"] == 2 and t["subject"] == "Quarterly report"
    assert sorted(json.loads(t["participants_json"])) == ["alice@example.com", "bob@example.com"]

    def search(q):
        return [
            r[0]
            for r in conn.execute(
                "SELECT m.subject FROM messages m WHERE m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.id",
                (q,),
            )
        ]

    assert search("spreadsheet") == ["Quarterly report"]
    assert len(search("people:bob")) == 3  # Bob is sender of one and recipient of the others
    assert search("subject:won") == ["You won!!!"]
    assert search("attachment_names:numbers") == ["Quarterly report"]
    assert search("zanzibar") == ["You won!!!"]
    view = conn.execute("SELECT * FROM message_list ORDER BY id").fetchall()
    assert view[1]["labels"] in ("Inbox, Unread", "Unread, Inbox")


def test_reimport_is_idempotent_and_updates_labels(archive, tmp_path):
    out, _, paths = archive
    res = run_import([str(paths["mbox"])], ImportOptions(out_dir=out, quiet=True))
    assert res.counts == dict(seen=3, inserted=0, labels_changed=0, unchanged=3, skipped=0, errors=0)

    # A newer export: message 2 was read and starred.
    newer = write_inputs(tmp_path / "newer", _mailbox(labels_for_2="Inbox,Starred"))
    res = run_import([str(newer["zip"])], ImportOptions(out_dir=out, quiet=True))
    assert res.counts["labels_changed"] == 1 and res.counts["inserted"] == 0
    conn = _db(out)
    m2 = conn.execute("SELECT * FROM messages WHERE gmail_id = '1000000000000000002'").fetchone()
    assert (m2["is_unread"], m2["is_starred"]) == (0, 1)
    names = {r[0] for r in conn.execute(
        "SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?", (m2["id"],))}
    assert names == {"Inbox", "Starred"}
    assert conn.execute("SELECT count(*) FROM messages").fetchone()[0] == 3
    assert conn.execute("SELECT count(*) FROM attachments").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM imports WHERE status = 'finished'").fetchone()[0] == 3


def test_skip_spam_trash_and_limit(tmp_path):
    paths = write_inputs(tmp_path / "in", _mailbox())
    out = tmp_path / "out"
    res = run_import([str(paths["gz"])], ImportOptions(out_dir=out, quiet=True, skip_spam_trash=True))
    assert res.counts["inserted"] == 2 and res.counts["skipped"] == 1
    out2 = tmp_path / "out2"
    res = run_import([str(paths["mbox"])], ImportOptions(out_dir=out2, quiet=True, limit=1))
    assert res.counts["seen"] == 1 and res.counts["inserted"] == 1


def test_cli_import_and_stats(tmp_path, capsys):
    paths = write_inputs(tmp_path / "in", _mailbox())
    out = tmp_path / "archive"
    assert main(["import", str(paths["mbox"]), "--out", str(out)]) == 0
    assert "3 new" in capsys.readouterr().out
    assert main(["stats", "--out", str(out)]) == 0
    text = capsys.readouterr().out
    assert "Messages:     3" in text and "Threads:      2" in text and "Spam" in text
    assert main(["import", str(tmp_path / "nope.mbox"), "--out", str(out)]) == 2


def test_big_message_streams(tmp_path):
    """A 20 MB attachment goes through intact; only one message is held at a time."""
    big = bytes(range(256)) * (20 * 1024 * 1024 // 256)
    mbox = mbox_bytes([("9", simple_message(attachments=[("big.bin", "application/octet-stream", big)])),
                       ("10", simple_message(subject="after"))])
    p = tmp_path / "big.mbox"
    p.write_bytes(mbox)
    out = tmp_path / "out"
    res = run_import([str(p)], ImportOptions(out_dir=out, quiet=True))
    assert res.counts["inserted"] == 2
    att = _db(out).execute("SELECT * FROM attachments").fetchone()
    assert (out / att["path"]).read_bytes() == big
