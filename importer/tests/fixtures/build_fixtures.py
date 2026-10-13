"""Build synthetic Takeout-style mbox data in code, so no real mail lives in the repo."""

from __future__ import annotations

import gzip
import io
import re
import sqlite3
import tarfile
import zipfile
from email.message import EmailMessage
from email.policy import SMTP
from pathlib import Path

_FROM_LINE_RE = re.compile(rb"^(>*From )", re.M)


def simple_message(
    subject: str = "Hello",
    body: str = "Hi there.\n",
    sender: str = "Alice Example <alice@example.com>",
    to: str = "Bob <bob@example.com>",
    date: str = "Wed, 24 Apr 2024 03:24:02 +0000",
    labels: str = "Inbox,Opened",
    thread_id: str | None = "1000000000000000001",
    message_id: str | None = "<m1@example.com>",
    html: str | None = None,
    attachments: list[tuple[str, str, bytes]] = (),
    extra_headers: dict[str, str] | None = None,
) -> bytes:
    """An RFC 822 message as Takeout writes it (CRLF line endings)."""
    msg = EmailMessage()
    if labels is not None:
        msg["X-GM-THRID"] = thread_id or ""
        msg["X-Gmail-Labels"] = labels
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = date
    if message_id:
        msg["Message-ID"] = message_id
    for k, v in (extra_headers or {}).items():
        msg[k] = v
    msg.set_content(body)
    if html is not None:
        msg.add_alternative(html, subtype="html")
    for filename, ctype, data in attachments:
        maintype, subtype = ctype.split("/", 1)
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return msg.as_bytes(policy=SMTP)


def mbox_bytes(messages: list[tuple[str, bytes]], date: str = "Wed Apr 24 03:24:02 +0000 2024") -> bytes:
    """Join (gmail_id, message_bytes) pairs into an mbox, escaping From_ lines (mboxrd)."""
    out = io.BytesIO()
    for gid, data in messages:
        out.write(f"From {gid}@xxx {date}\r\n".encode())
        out.write(_FROM_LINE_RE.sub(rb">\1", data))
        if not data.endswith(b"\n"):
            out.write(b"\r\n")
        out.write(b"\r\n")
    return out.getvalue()


def write_inputs(tmp: Path, mbox: bytes, inner_name: str = "Takeout/Mail/All mail Including Spam and Trash.mbox") -> dict[str, Path]:
    """Write the same mbox as .mbox, .mbox.gz, .tgz and .zip. Returns {kind: path}."""
    tmp.mkdir(parents=True, exist_ok=True)
    paths = {}
    p = tmp / "mail.mbox"
    p.write_bytes(mbox)
    paths["mbox"] = p

    p = tmp / "mail.mbox.gz"
    with gzip.open(p, "wb") as f:
        f.write(mbox)
    paths["gz"] = p

    p = tmp / "takeout.tgz"
    with tarfile.open(p, "w:gz") as tf:
        info = tarfile.TarInfo("Takeout/README.txt")
        readme = b"not mail"
        info.size = len(readme)
        tf.addfile(info, io.BytesIO(readme))
        info = tarfile.TarInfo(inner_name)
        info.size = len(mbox)
        tf.addfile(info, io.BytesIO(mbox))
    paths["tgz"] = p

    p = tmp / "takeout.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Takeout/README.txt", b"not mail")
        zf.writestr(inner_name, mbox)
    paths["zip"] = p
    return paths


def downgrade_to_v2(db_path: Path) -> None:
    """Turn a current archive back into a schema v2 archive, to test upgrades."""
    c = sqlite3.connect(db_path)
    c.executescript(
        """
        DROP TRIGGER thread_notes_ai; DROP TRIGGER thread_notes_ad; DROP TRIGGER thread_notes_au;
        DROP TABLE notes_fts; DROP TABLE thread_notes; DROP TABLE message_addresses;
        DROP INDEX messages_list; DROP INDEX messages_size; DROP INDEX attachments_size;
        ALTER TABLE messages DROP COLUMN list_id;
        ALTER TABLE messages DROP COLUMN list_name;
        ALTER TABLE attachments DROP COLUMN deleted_at;
        UPDATE meta SET value = '2' WHERE key = 'schema_version';
        """
    )
    c.close()
