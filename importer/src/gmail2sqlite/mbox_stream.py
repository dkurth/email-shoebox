"""Split an mbox byte stream into messages, one at a time.

A message starts at a line beginning with ``From `` that is at the start of the
file or follows a blank line. Lines in the body that start with ``>From ``,
``>>From `` and so on are un-escaped by removing one ``>`` (the "mboxrd" rule).
Google Takeout escapes every body line that starts with ``From ``, so the
separator rule is unambiguous on Takeout exports.

Only one message is held in memory at a time.
"""

from __future__ import annotations

import hashlib
import re
import time
from calendar import timegm
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

# Takeout writes "From 1797184859426826706@xxx Wed Apr 24 03:24:02 +0000 2024".
# The number is Gmail's own message ID (X-GM-MSGID).
_GMAIL_ID_RE = re.compile(rb"^(\d+)@xxx$")
_ESCAPED_FROM_RE = re.compile(rb"^>+From ")


@dataclass
class RawMessage:
    gmail_id: str  # Gmail's message ID, or "sha256-<hex>" for non-Takeout mboxes
    from_line: bytes  # the separator line, without its line ending
    data: bytes  # the RFC 822 message (headers + body), un-escaped
    received_utc: int | None  # date from the separator line (Gmail's internal date)


def _is_blank(line: bytes) -> bool:
    return line in (b"\n", b"\r\n", b"\r")


def gmail_id_from_line(from_line: bytes) -> str | None:
    parts = from_line.split(None, 2)
    if len(parts) >= 2:
        m = _GMAIL_ID_RE.match(parts[1])
        if m:
            return m.group(1).decode("ascii")
    return None


def received_from_line(from_line: bytes) -> int | None:
    """Parse the date at the end of a From_ line into epoch seconds, if possible."""
    parts = from_line.split(None, 2)
    if len(parts) < 3:
        return None
    text = parts[2].decode("ascii", "replace").strip()
    for fmt in ("%a %b %d %H:%M:%S %z %Y", "%a %b %d %H:%M:%S %Y"):
        try:
            t = time.strptime(text, fmt)
        except ValueError:
            continue
        offset = t.tm_gmtoff or 0
        return timegm(t) - offset
    return None


def _finish(from_line: bytes, lines: list[bytes]) -> RawMessage:
    # The blank line before the next separator belongs to the mbox format, not the message.
    if lines and _is_blank(lines[-1]):
        lines.pop()
    data = b"".join(lines)
    gid = gmail_id_from_line(from_line)
    if gid is None:
        gid = "sha256-" + hashlib.sha256(data).hexdigest()
    return RawMessage(
        gmail_id=gid,
        from_line=from_line,
        data=data,
        received_utc=received_from_line(from_line),
    )


def iter_messages(stream: Iterable[bytes]) -> Iterator[RawMessage]:
    """Yield messages from an iterable of lines (a binary file object works)."""
    from_line: bytes | None = None
    lines: list[bytes] = []
    prev_blank = True  # start of file counts as "after a blank line"

    for line in stream:
        if prev_blank and line.startswith(b"From "):
            if from_line is not None:
                yield _finish(from_line, lines)
            from_line = line.rstrip(b"\r\n")
            lines = []
            prev_blank = False
            continue

        prev_blank = _is_blank(line)
        if from_line is None:
            # Junk before the first separator; not part of any message.
            continue
        if line.startswith(b">") and _ESCAPED_FROM_RE.match(line):
            line = line[1:]
        lines.append(line)

    if from_line is not None:
        yield _finish(from_line, lines)
