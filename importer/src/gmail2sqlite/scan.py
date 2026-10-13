"""Read the inputs once, quickly, without importing: what is there, how big it is, and whose mail it is.

The desktop app runs this before an import, to show "14 mbox files, 11.6 GB",
check free disk space, and suggest a name like "me@example.com (2004-2024)".

It doesn't split the mbox line by line (that is what makes an import slow).
It reads big chunks and looks only at the separator lines and the headers right
after them:

- the date on Takeout's ``From <id>@xxx <date>`` line (Gmail's internal date);
- ``From:`` on messages labeled Sent, to find the owner's address (the same
  rule the viewer uses for "me");
- ``Delivered-To:``, as a fallback for an export with no Sent mail.
"""

from __future__ import annotations

import re
import time
import zipfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path
from typing import BinaryIO

from .mbox_stream import received_from_line
from .parse import labels_from_raw
from .sources import Progress, _is_mbox_name, _kind, expand_paths, iter_mbox_streams

CHUNK = 4 << 20
MAX_HEADER = 1 << 20  # a header block longer than this is cut off (it only affects the guesses)

# A separator is "From " at the start of a line that follows a blank line. The scan
# starts with "\n\n" in its buffer, so the first message of a file matches too.
_SEP = re.compile(rb"\n\r?\nFrom ")
_HEADER_END = re.compile(rb"\n\r?\n")
_FROM_HDR = re.compile(rb"^From:[ \t]*(.*(?:\r?\n[ \t].*)*)", re.MULTILINE | re.IGNORECASE)
_DELIVERED_TO = re.compile(rb"^Delivered-To:[ \t]*(\S+)", re.MULTILINE | re.IGNORECASE)


@dataclass
class MboxSummary:
    name: str
    bytes: int = 0  # uncompressed
    messages: int = 0


@dataclass
class ScanResult:
    files: list[str]
    bytes_on_disk: int
    mboxes: list[MboxSummary] = field(default_factory=list)
    first_date: int | None = None  # epoch seconds
    last_date: int | None = None
    owner: str | None = None
    sent_from: Counter = field(default_factory=Counter)
    delivered_to: Counter = field(default_factory=Counter)

    @property
    def messages(self) -> int:
        return sum(m.messages for m in self.mboxes)

    @property
    def uncompressed_bytes(self) -> int:
        return sum(m.bytes for m in self.mboxes)

    def to_json(self) -> dict:
        return dict(
            type="result",
            files=self.files,
            bytes_on_disk=self.bytes_on_disk,
            uncompressed_bytes=self.uncompressed_bytes,
            mbox_count=len(self.mboxes),
            messages=self.messages,
            first_date=self.first_date,
            last_date=self.last_date,
            owner=self.owner,
            mboxes=[dict(name=m.name, bytes=m.bytes, messages=m.messages) for m in self.mboxes],
        )


def quick_look(paths: list[str]) -> dict:
    """What can be known without reading the mail: the files, their size, and (for .mbox and .zip) the mbox count
    and uncompressed size. ``None`` means "known only after the full scan"."""
    files = expand_paths(paths)
    mbox_count: int | None = 0
    uncompressed: int | None = 0
    for f in files:
        kind = _kind(f)
        if kind == "mbox":
            mbox_count = None if mbox_count is None else mbox_count + 1
            uncompressed = None if uncompressed is None else uncompressed + f.stat().st_size
        elif kind == "zip":
            with zipfile.ZipFile(f) as zf:
                members = [i for i in zf.infolist() if not i.is_dir() and _is_mbox_name(i.filename)]
            mbox_count = None if mbox_count is None else mbox_count + len(members)
            uncompressed = None if uncompressed is None else uncompressed + sum(i.file_size for i in members)
        else:  # gz, tgz, tar: only reading them tells
            mbox_count = uncompressed = None
    return dict(
        type="files",
        files=[str(f) for f in files],
        bytes_on_disk=sum(f.stat().st_size for f in files),
        mbox_count=mbox_count,
        uncompressed_bytes=uncompressed,
    )


def _visit(block: bytes, summary: MboxSummary, result: ScanResult) -> None:
    """One message's separator line and headers."""
    summary.messages += 1
    nl = block.find(b"\n")
    from_line = block[: nl if nl >= 0 else len(block)].rstrip(b"\r")
    received = received_from_line(from_line)
    if received is not None:
        result.first_date = received if result.first_date is None else min(result.first_date, received)
        result.last_date = received if result.last_date is None else max(result.last_date, received)
    headers = block[nl + 1 :] if nl >= 0 else b""
    m = _DELIVERED_TO.search(headers)
    if m:
        result.delivered_to[m.group(1).decode("ascii", "replace").strip("<>").lower()] += 1
    if b"Sent" in headers and "Sent" in labels_from_raw(headers):
        m = _FROM_HDR.search(headers)
        if m:
            value = m.group(1).decode("utf-8", "replace")
            try:
                value = str(make_header(decode_header(value)))
            except Exception:
                pass
            addr = parseaddr(value)[1].strip().lower()
            if "@" in addr:
                result.sent_from[addr] += 1


def _scan_stream(stream: BinaryIO, summary: MboxSummary, result: ScanResult, tick: Callable[[], None]) -> None:
    buf = b"\n\n"
    pos = 0  # where to look for the next separator
    eof = False
    while not eof:
        chunk = stream.read(CHUNK)
        eof = not chunk
        summary.bytes += len(chunk)
        buf += chunk
        while True:
            m = _SEP.search(buf, pos)
            if m is None:
                pos = max(pos, len(buf) - 7)  # a separator ("\n\r\nFrom ", 8 bytes) can start in the last bytes
                break
            start = m.end() - 5
            h = _HEADER_END.search(buf, start, start + MAX_HEADER)
            if h is None and not eof and len(buf) - start < MAX_HEADER:
                pos = m.start()  # the headers continue in the next chunk; match this separator again
                break
            end = h.start() if h else min(len(buf), start + MAX_HEADER)
            _visit(buf[start:end], summary, result)
            pos = end
        buf = buf[pos:]
        pos = 0
        tick()


def scan(paths: list[str], on_progress: Callable[[int, int], None] | None = None) -> ScanResult:
    """Read every mbox in the inputs. ``on_progress(bytes_done, bytes_total)`` is called about 4 times a second,
    with sizes on disk (compressed), like an import's progress."""
    files = expand_paths(paths)
    progress = Progress(files)
    result = ScanResult(files=[str(f) for f in files], bytes_on_disk=progress.total)
    last = 0.0

    def tick() -> None:
        nonlocal last
        now = time.monotonic()
        if on_progress and now - last >= 0.25:
            last = now
            on_progress(progress.done, progress.total)

    for src in iter_mbox_streams(files, progress):
        summary = MboxSummary(name=Path(src.name.replace("\\", "/").split("!")[-1]).name)
        result.mboxes.append(summary)
        _scan_stream(src.stream, summary, result, tick)
    if on_progress:
        on_progress(progress.total, progress.total)
    if result.sent_from:
        result.owner = result.sent_from.most_common(1)[0][0]
    elif result.delivered_to:
        result.owner = result.delivered_to.most_common(1)[0][0]
    return result
