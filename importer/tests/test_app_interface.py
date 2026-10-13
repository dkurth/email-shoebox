"""What the desktop app relies on: JSON progress and errors, cancelling, scan, and upgrade."""

import io
import json
import sqlite3
import threading
from calendar import timegm

import pytest
from build_fixtures import downgrade_to_v2, mbox_bytes, simple_message, write_inputs

from gmail2sqlite import cli, scan as scan_mod
from gmail2sqlite.cli import main
from gmail2sqlite.importer import ImportOptions, run_import
from gmail2sqlite.mbox_stream import iter_messages


def _mailbox(n=3, owner="me@example.com"):
    """n messages over three years. Every third one is Sent mail from the owner."""
    msgs = []
    for i in range(n):
        sent = i % 3 == 0
        msgs.append(
            (
                f"10000000000000{i:05d}",
                simple_message(
                    subject=f"message {i}",
                    sender=f"Me <{owner.upper() if i == 0 else owner}>" if sent else f"Other <other{i}@example.com>",
                    to="Someone <someone@example.com>" if sent else f"Me <{owner}>",
                    labels="Sent" if sent else "Inbox",
                    thread_id=f"10000000000000{i:05d}",
                    message_id=f"<m{i}@example.com>",
                    extra_headers=None if sent else {"Delivered-To": owner},
                ),
            )
        )
    data = b""
    for i, (gid, msg) in enumerate(msgs):
        year = 2019 + i % 3
        data += mbox_bytes([(gid, msg)], date=f"Wed Apr 24 03:24:02 +0000 {year}")
    return data


def _lines(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# ---------------------------------------------------------------- import --progress=json


def test_json_progress_ends_with_done(tmp_path, capsys):
    mbox = tmp_path / "Inbox.mbox"
    mbox.write_bytes(_mailbox(5))
    assert main(["import", str(mbox), "--out", str(tmp_path / "out"), "--progress=json"]) == 0
    out = _lines(capsys.readouterr().out)
    assert out[0]["type"] == "progress"
    assert out[0]["mbox"] == "Inbox.mbox" and out[0]["mbox_index"] == 1
    assert out[-2]["type"] == "progress"
    assert out[-2]["bytes_done"] == out[-2]["bytes_total"] == mbox.stat().st_size
    done = out[-1]
    assert done["type"] == "done" and done["status"] == "finished"
    assert done["counts"]["inserted"] == 5 and done["counts"]["errors"] == 0


def test_json_progress_names_the_mbox_inside_a_zip(tmp_path, capsys):
    paths = write_inputs(tmp_path / "in", _mailbox(2), inner_name="Takeout/Mail/Sent.mbox")
    assert main(["import", str(paths["zip"]), "--out", str(tmp_path / "out"), "--progress=json"]) == 0
    progress = [x for x in _lines(capsys.readouterr().out) if x["type"] == "progress"]
    assert progress[-1]["mbox"] == "Sent.mbox"


def test_json_errors_go_to_stderr(tmp_path, capsys):
    code = main(["import", str(tmp_path / "missing.mbox"), "--out", str(tmp_path / "out"), "--progress=json"])
    assert code == 2
    err = _lines(capsys.readouterr().err)
    assert err == [{"type": "error", "kind": "input", "message": f"no such file or folder: {tmp_path / 'missing.mbox'}"}]


def test_json_error_for_a_newer_schema(tmp_path, capsys):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(1))
    out = tmp_path / "out"
    run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    c = sqlite3.connect(out / "mail.db")
    c.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
    c.commit()
    c.close()
    assert main(["import", str(mbox), "--out", str(out), "--progress=json"]) == 2
    err = _lines(capsys.readouterr().err)
    assert err[0]["kind"] == "schema" and "newer" in err[0]["message"]


# ---------------------------------------------------------------- cancelling


class _CancelAfter(threading.Event):
    """An event that turns on by itself after it is checked n times."""

    def __init__(self, n):
        super().__init__()
        self.n = n

    def is_set(self):
        self.n -= 1
        return self.n < 0


def test_cancel_keeps_what_was_imported(tmp_path, capsys):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(6))
    out = tmp_path / "out"
    result = run_import([str(mbox)], ImportOptions(out_dir=out, progress="json", cancel=_CancelAfter(2)))
    assert result.status == "interrupted"
    assert result.counts["inserted"] == 2
    assert _lines(capsys.readouterr().out)[-1]["status"] == "interrupted"
    c = sqlite3.connect(out / "mail.db")
    assert c.execute("SELECT status, inserted FROM imports").fetchone() == ("interrupted", 2)
    assert c.execute("SELECT count(*) FROM threads").fetchone()[0] == 2  # threads were rebuilt

    # Importing again continues where it stopped.
    result = run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    assert result.status == "finished"
    assert (result.counts["inserted"], result.counts["unchanged"]) == (4, 2)


def test_stdin_cancel_and_close(monkeypatch):
    for text in ("cancel\n", ""):
        monkeypatch.setattr("sys.stdin", io.StringIO(text))
        event = threading.Event()
        cli._watch_stdin(event)
        assert event.wait(5)


def test_stdin_other_lines_do_not_cancel(monkeypatch):
    class Blocking(io.StringIO):
        def __iter__(self):
            yield "hello\n"
            threading.Event().wait(10)  # stays open

    monkeypatch.setattr("sys.stdin", Blocking())
    event = threading.Event()
    cli._watch_stdin(event)
    assert not event.wait(0.3)


# ---------------------------------------------------------------- scan


def test_scan_finds_owner_dates_and_counts(tmp_path):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(9))
    r = scan_mod.scan([str(mbox)])
    assert r.owner == "me@example.com"  # lower case, though message 0 says ME@EXAMPLE.COM
    assert r.messages == 9 and len(r.mboxes) == 1
    assert r.uncompressed_bytes == mbox.stat().st_size
    assert (r.first_date, r.last_date) == (timegm((2019, 4, 24, 3, 24, 2)), timegm((2021, 4, 24, 3, 24, 2)))
    assert r.sent_from["me@example.com"] == 3


def test_scan_falls_back_to_delivered_to(tmp_path):
    msgs = [("1", simple_message(labels="Inbox", extra_headers={"Delivered-To": "Owner@Example.com"}))]
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(mbox_bytes(msgs))
    assert scan_mod.scan([str(mbox)]).owner == "owner@example.com"


def test_scan_with_no_clue_has_no_owner(tmp_path):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(mbox_bytes([("1", simple_message(labels="Inbox"))]))
    assert scan_mod.scan([str(mbox)]).owner is None


@pytest.mark.parametrize("chunk", [7, 64, 1000, 1 << 20])
def test_scan_counts_match_the_importer_at_any_chunk_size(tmp_path, monkeypatch, chunk):
    monkeypatch.setattr(scan_mod, "CHUNK", chunk)
    msgs = [
        ("1", simple_message(body="From the start of a line\n\nFrom again after a blank line\n")),
        ("2", simple_message(body="")),
        ("3", simple_message(attachments=[("a.bin", "application/octet-stream", bytes(range(256)) * 50)])),
        ("4", b"Subject: no body and LF only\n\n"),
    ]
    data = mbox_bytes(msgs) + b"From 5@xxx Wed Apr 24 03:24:02 +0000 2024\nSubject: last, LF only\n\nbody\n"
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(data)
    expected = sum(1 for _ in iter_messages(io.BytesIO(data)))
    assert expected == 5
    assert scan_mod.scan([str(mbox)]).messages == expected


@pytest.mark.parametrize("kind", ["mbox", "gz", "tgz", "zip"])
def test_scan_reads_every_input_kind(tmp_path, kind):
    data = _mailbox(4)
    paths = write_inputs(tmp_path / "in", data, inner_name="Takeout/Mail/Inbox.mbox")
    r = scan_mod.scan([str(paths[kind])])
    assert r.messages == 4 and r.owner == "me@example.com"
    assert r.uncompressed_bytes == len(data)
    assert r.mboxes[0].name in ("Inbox.mbox", "mail.mbox", "mail.mbox.gz")


def test_quick_look_knows_mbox_and_zip_sizes_but_not_tgz(tmp_path):
    data = _mailbox(2)
    paths = write_inputs(tmp_path / "in", data)
    ql = scan_mod.quick_look([str(paths["mbox"]), str(paths["zip"])])
    assert (ql["mbox_count"], ql["uncompressed_bytes"]) == (2, 2 * len(data))
    ql = scan_mod.quick_look([str(paths["tgz"])])
    assert (ql["mbox_count"], ql["uncompressed_bytes"]) == (None, None)
    assert ql["bytes_on_disk"] == paths["tgz"].stat().st_size


def test_scan_json_lines(tmp_path, capsys):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(3))
    assert main(["scan", str(mbox), "--json"]) == 0
    out = _lines(capsys.readouterr().out)
    assert out[0]["type"] == "files" and out[0]["mbox_count"] == 1
    assert out[-2] == {"type": "progress", "bytes_done": mbox.stat().st_size, "bytes_total": mbox.stat().st_size}
    assert out[-1]["type"] == "result" and out[-1]["owner"] == "me@example.com" and out[-1]["messages"] == 3


def test_scan_json_error(tmp_path, capsys):
    assert main(["scan", str(tmp_path), "--json"]) == 2
    assert _lines(capsys.readouterr().err)[0]["kind"] == "input"


# ---------------------------------------------------------------- upgrade


def test_upgrade_a_v2_archive(tmp_path, capsys):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(2))
    out = tmp_path / "out"
    run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    downgrade_to_v2(out / "mail.db")
    assert main(["upgrade", "--out", str(out), "--json"]) == 0
    assert _lines(capsys.readouterr().out) == [{"type": "done", "from_version": 2, "to_version": 3}]
    c = sqlite3.connect(out / "mail.db")
    assert c.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0] == "3"


def test_upgrade_a_current_archive_does_nothing(tmp_path, capsys):
    mbox = tmp_path / "in.mbox"
    mbox.write_bytes(_mailbox(1))
    out = tmp_path / "out"
    run_import([str(mbox)], ImportOptions(out_dir=out, quiet=True))
    assert main(["upgrade", "--out", str(out)]) == 0
    assert "already at schema version 3" in capsys.readouterr().out


def test_upgrade_without_an_archive(tmp_path, capsys):
    assert main(["upgrade", "--out", str(tmp_path), "--json"]) == 2
    assert _lines(capsys.readouterr().err)[0]["kind"] == "input"
