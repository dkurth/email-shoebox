"""Write attachments to disk as decoded files.

Layout (relative to the output folder):

    attachments/{bucket}/{gmail_id}/{NN}-{safe_filename}

``bucket`` is the first two hex characters of sha1(gmail_id). Gmail IDs are
time-based, so their leading digits barely vary; hashing spreads messages
evenly over 256 folders. ``NN`` is the attachment's position in the message,
which keeps two attachments with the same name apart.

Filenames come from whoever sent the email, so they are sanitized: no path
separators, no control or shell-hostile characters, no leading dots, and a
length limit.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .parse import AttachmentPart

ATTACHMENTS_DIR = "attachments"
MAX_NAME_BYTES = 150

_UNSAFE_RE = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')
_EXTRA_EXTENSIONS = {
    "message/rfc822": ".eml",
    "message/global": ".eml",
    "message/delivery-status": ".txt",
    "text/plain": ".txt",
    "text/calendar": ".ics",
    "image/jpeg": ".jpg",
}


@dataclass
class SavedAttachment:
    path: str  # relative to the output folder, with forward slashes
    sha256: str
    size_bytes: int


def _truncate_utf8(s: str, max_bytes: int) -> str:
    b = s.encode("utf-8")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", "ignore")


def _default_name(content_type: str) -> str:
    ext = _EXTRA_EXTENSIONS.get(content_type) or mimetypes.guess_extension(content_type) or ".bin"
    return "attachment" + ext


def safe_filename(name: str | None, content_type: str = "application/octet-stream") -> str:
    """Return a filename that is safe to create inside a folder we control."""
    name = unicodedata.normalize("NFC", name or "")
    name = name.replace("\\", "/").rsplit("/", 1)[-1]  # drop any path
    name = _UNSAFE_RE.sub("_", name)
    name = name.strip().lstrip(".").rstrip(". ").strip()
    if not name or set(name) <= {"_"}:
        return _default_name(content_type)
    stem, ext = os.path.splitext(name)
    if len(ext.encode("utf-8")) > 20:  # not a real extension
        stem, ext = name, ""
    stem = _truncate_utf8(stem, MAX_NAME_BYTES - len(ext.encode("utf-8"))).rstrip(". ")
    return (stem or "attachment") + ext


def message_dir(gmail_id: str) -> str:
    bucket = hashlib.sha1(gmail_id.encode("utf-8")).hexdigest()[:2]
    return f"{ATTACHMENTS_DIR}/{bucket}/{gmail_id}"


def attachment_path(gmail_id: str, part: AttachmentPart) -> str:
    return f"{message_dir(gmail_id)}/{part.index:02d}-{safe_filename(part.filename, part.content_type)}"


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def save_attachment(out_dir: Path, gmail_id: str, part: AttachmentPart) -> SavedAttachment:
    """Write one attachment atomically. An identical existing file is left alone."""
    rel = attachment_path(gmail_id, part)
    target = out_dir / rel
    digest = hashlib.sha256(part.data).hexdigest()
    saved = SavedAttachment(path=rel, sha256=digest, size_bytes=len(part.data))

    # Belt and braces: the sanitized path must stay inside the attachments folder.
    root = (out_dir / ATTACHMENTS_DIR).resolve()
    if root not in target.resolve().parents:
        raise ValueError(f"unsafe attachment path: {rel!r}")

    try:
        if target.stat().st_size == len(part.data) and _file_sha256(target) == digest:
            return saved
    except FileNotFoundError:
        pass

    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(part.data)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return saved
