import io

import pytest
from build_fixtures import mbox_bytes, simple_message, write_inputs

from gmail2sqlite.mbox_stream import iter_messages, received_from_line
from gmail2sqlite.sources import Progress, SourceError, expand_paths, iter_mbox_streams


def _msgs(data: bytes):
    return list(iter_messages(io.BytesIO(data)))


def test_splits_messages_and_reads_gmail_ids():
    m1 = simple_message(subject="one")
    m2 = simple_message(subject="two")
    out = _msgs(mbox_bytes([("1111", m1), ("2222", m2)]))
    assert [m.gmail_id for m in out] == ["1111", "2222"]
    assert out[0].data == m1
    assert out[1].data == m2
    assert out[0].received_utc == 1713929042


def test_unescapes_from_lines_in_body():
    body = "line\nFrom here on, things changed.\n>From quoted\nok\n"
    m = simple_message(body=body)
    escaped = mbox_bytes([("1", m), ("2", simple_message())])
    assert b"\n>From here" in escaped and b"\n>>From quoted" in escaped
    out = _msgs(escaped)
    assert len(out) == 2
    assert out[0].data == m


def test_from_line_not_after_blank_is_not_a_separator():
    data = b"From 1@xxx Wed Apr 24 03:24:02 +0000 2024\nSubject: a\n\nbody\nFrom unescaped mid-paragraph\n"
    out = _msgs(data)
    assert len(out) == 1
    assert b"From unescaped" in out[0].data


def test_non_takeout_mbox_gets_content_hash_id():
    data = b"From someone@example.com Mon Jan  1 00:00:00 2001\nSubject: a\n\nbody\n"
    (m,) = _msgs(data)
    assert m.gmail_id.startswith("sha256-") and len(m.gmail_id) == 7 + 64
    assert m.received_utc == 978307200


def test_received_from_line_garbage():
    assert received_from_line(b"From x@xxx not a date") is None
    assert received_from_line(b"From") is None


def test_empty_and_junk_prefix():
    assert _msgs(b"") == []
    out = _msgs(b"junk\n\nFrom 5@xxx Wed Apr 24 03:24:02 +0000 2024\nSubject: x\n\nhi\n")
    assert [m.gmail_id for m in out] == ["5"]


@pytest.mark.parametrize("kind", ["mbox", "gz", "tgz", "zip"])
def test_all_input_kinds(tmp_path, kind):
    mbox = mbox_bytes([(str(i), simple_message(subject=f"s{i}")) for i in range(5)])
    paths = write_inputs(tmp_path, mbox)
    files = expand_paths([paths[kind]])
    progress = Progress(files)
    ids, names = [], []
    for s in iter_mbox_streams(files, progress):
        names.append(s.name)
        ids.extend(m.gmail_id for m in iter_messages(s.stream))
    assert len(names) == 1  # README.txt inside the archives is ignored
    assert ".mbox" in names[0]
    assert ids == ["0", "1", "2", "3", "4"]
    assert progress.done == progress.total


def test_folder_input_and_errors(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "x.mbox").write_bytes(b"")
    (tmp_path / "a" / "notes.txt").write_text("no")
    assert [p.name for p in expand_paths([tmp_path])] == ["x.mbox"]
    with pytest.raises(SourceError):
        expand_paths([tmp_path / "a" / "notes.txt"])
    with pytest.raises(SourceError):
        expand_paths([tmp_path / "missing"])
