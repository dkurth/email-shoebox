import hashlib

import pytest

from gmail2sqlite.attachments import attachment_path, message_dir, safe_filename, save_attachment
from gmail2sqlite.parse import AttachmentPart


@pytest.mark.parametrize(
    "name, expected",
    [
        ("report.pdf", "report.pdf"),
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\x.dll", "x.dll"),
        ("/abs/path.txt", "path.txt"),
        (".bashrc", "bashrc"),
        ("..", "attachment.bin"),
        ("", "attachment.bin"),
        (None, "attachment.bin"),
        ("a\x00b\nc\td.txt", "a_b_c_d.txt"),
        ('what?<is>:"this"|*.doc', "what__is___this___.doc"),
        ("trailing dots...", "trailing dots"),
        ("été.txt", "été.txt"),  # NFD -> NFC
        ("???", "attachment.bin"),
    ],
)
def test_safe_filename(name, expected):
    assert safe_filename(name) == expected


def test_safe_filename_defaults_by_type():
    assert safe_filename(None, "image/png") == "attachment.png"
    assert safe_filename(None, "message/rfc822") == "attachment.eml"


def test_long_names_keep_extension_and_utf8():
    name = "ü" * 300 + ".pdf"
    out = safe_filename(name)
    assert out.endswith(".pdf")
    assert len(out.encode("utf-8")) <= 150
    out.encode("utf-8")  # valid UTF-8, no split characters


def test_paths_and_buckets():
    part = AttachmentPart(index=3, filename="a.pdf", content_type="application/pdf", content_id=None, is_inline=False, data=b"")
    p = attachment_path("1797184859426826706", part)
    bucket = hashlib.sha1(b"1797184859426826706").hexdigest()[:2]
    assert p == f"attachments/{bucket}/1797184859426826706/03-a.pdf"
    assert message_dir("sha256-abc").endswith("/sha256-abc")


def test_save_is_atomic_and_idempotent(tmp_path):
    part = AttachmentPart(index=1, filename="x.txt", content_type="text/plain", content_id=None, is_inline=False, data=b"hello")
    s1 = save_attachment(tmp_path, "42", part)
    f = tmp_path / s1.path
    assert f.read_bytes() == b"hello"
    assert s1.sha256 == hashlib.sha256(b"hello").hexdigest() and s1.size_bytes == 5
    mtime = f.stat().st_mtime_ns
    s2 = save_attachment(tmp_path, "42", part)
    assert s2 == s1 and f.stat().st_mtime_ns == mtime  # unchanged file not rewritten
    part.data = b"changed"
    save_attachment(tmp_path, "42", part)
    assert f.read_bytes() == b"changed"
    assert not [p for p in f.parent.iterdir() if p.name.startswith(".tmp-")]


def test_duplicate_names_do_not_collide(tmp_path):
    a = AttachmentPart(1, "same.txt", "text/plain", None, False, b"one")
    b = AttachmentPart(2, "same.txt", "text/plain", None, False, b"two")
    pa, pb = save_attachment(tmp_path, "7", a), save_attachment(tmp_path, "7", b)
    assert pa.path != pb.path
    assert (tmp_path / pa.path).read_bytes() == b"one" and (tmp_path / pb.path).read_bytes() == b"two"
