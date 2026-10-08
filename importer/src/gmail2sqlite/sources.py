"""Open Takeout inputs (.mbox, .mbox.gz, .tgz/.tar.gz, .zip, or a folder) as binary streams.

Nothing is extracted to disk and nothing is read fully into memory: gzip and tar
are read in streaming mode, and a zip member is read through zipfile's stream.

Progress is measured on the *compressed* input: each source reports how far into
the underlying file on disk it has read, via ``raw.tell()``.
"""

from __future__ import annotations

import gzip
import os
import tarfile
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


class SourceError(Exception):
    pass


@dataclass
class MboxStream:
    """One mbox to read. ``name`` is for messages and the imports table."""

    name: str
    stream: BinaryIO


def _is_mbox_name(name: str) -> bool:
    return name.lower().endswith(".mbox")


def _kind(path: Path) -> str:
    n = path.name.lower()
    if n.endswith((".tgz", ".tar.gz")):
        return "tgz"
    if n.endswith(".tar"):
        return "tar"
    if n.endswith(".zip"):
        return "zip"
    if n.endswith(".mbox.gz"):
        return "gz"
    if n.endswith(".mbox"):
        return "mbox"
    raise SourceError(f"unsupported input (expected .mbox, .mbox.gz, .tgz, .tar.gz, .tar or .zip): {path}")


def expand_paths(paths: list[str | os.PathLike]) -> list[Path]:
    """Turn the CLI arguments into a list of input files. Folders are searched recursively."""
    out: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            found = sorted(
                f for f in p.rglob("*") if f.is_file() and not f.name.startswith(".") and _is_supported(f)
            )
            if not found:
                raise SourceError(f"no .mbox or archive files found in folder: {p}")
            out.extend(found)
        elif p.is_file():
            _kind(p)  # validate
            out.append(p)
        else:
            raise SourceError(f"no such file or folder: {p}")
    return out


def _is_supported(path: Path) -> bool:
    try:
        _kind(path)
        return True
    except SourceError:
        return False


class Progress:
    """Tracks compressed bytes read across all input files."""

    def __init__(self, files: list[Path]):
        self.total = sum(f.stat().st_size for f in files)
        self._done_before = 0  # sizes of files already finished
        self._raw: BinaryIO | None = None

    def _start(self, raw: BinaryIO) -> None:
        self._raw = raw

    def _finish(self, size: int) -> None:
        self._done_before += size
        self._raw = None

    @property
    def done(self) -> int:
        cur = 0
        if self._raw is not None:
            try:
                cur = self._raw.tell()
            except (OSError, ValueError):
                cur = 0
        return min(self._done_before + cur, self.total)


@contextmanager
def _open_raw(path: Path, progress: Progress | None):
    with open(path, "rb") as raw:
        if progress:
            progress._start(raw)
        try:
            yield raw
        finally:
            if progress:
                progress._finish(path.stat().st_size)


def iter_mbox_streams(files: list[Path], progress: Progress | None = None) -> Iterator[MboxStream]:
    """Yield each mbox found in the inputs, in order, as a binary stream.

    Each stream must be fully consumed (or abandoned) before the next one is
    requested; that's what makes streaming tar work.
    """
    for path in files:
        kind = _kind(path)
        with _open_raw(path, progress) as raw:
            if kind == "mbox":
                yield MboxStream(str(path), raw)
            elif kind == "gz":
                with gzip.GzipFile(fileobj=raw, mode="rb") as gz:
                    yield MboxStream(str(path), gz)
            elif kind in ("tgz", "tar"):
                mode = "r|gz" if kind == "tgz" else "r|"
                with tarfile.open(fileobj=raw, mode=mode) as tf:
                    for member in tf:
                        if member.isfile() and _is_mbox_name(member.name):
                            f = tf.extractfile(member)
                            if f is not None:
                                yield MboxStream(f"{path}!{member.name}", f)
            elif kind == "zip":
                with zipfile.ZipFile(raw) as zf:
                    for info in zf.infolist():
                        if not info.is_dir() and _is_mbox_name(info.filename):
                            with zf.open(info) as f:
                                yield MboxStream(f"{path}!{info.filename}", f)
