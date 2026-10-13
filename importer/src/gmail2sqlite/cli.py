"""Command line: ``gmail2sqlite import``, ``scan``, ``upgrade`` and ``stats``.

With ``--progress=json`` (import) or ``--json`` (scan, upgrade), progress and
results are JSON lines on stdout, and errors are JSON lines on stderr:
``{"type": "error", "kind": "input" | "schema" | "disk_full" | "internal", "message": ...}``.
Other stderr lines (such as "Upgrading database...") are plain text for a log.
"""

from __future__ import annotations

import argparse
import errno
import json
import signal
import sqlite3
import sys
import threading
import time
import traceback
from pathlib import Path

from . import __version__, db
from .importer import ImportOptions, run_import
from .scan import quick_look, scan
from .sources import SourceError

DEFAULT_OUT = "./gmail-archive"


def _json_line(obj: dict, stream=None) -> None:
    stream = stream or sys.stdout
    stream.write(json.dumps(obj) + "\n")
    stream.flush()


def _error(kind: str, message: str, as_json: bool) -> None:
    if as_json:
        _json_line(dict(type="error", kind=kind, message=message), sys.stderr)
    else:
        print(f"error: {message}", file=sys.stderr)


def _run_reporting_errors(fn, as_json: bool) -> int:
    """Run a command; turn the errors a user can act on into a message and an exit code."""
    try:
        return fn()
    except SourceError as e:
        _error("input", str(e), as_json)
        return 2
    except db.SchemaError as e:
        _error("schema", str(e), as_json)
        return 2
    except OSError as e:
        if e.errno != errno.ENOSPC:
            raise
        _error("disk_full", f"The disk is full: {e}", as_json)
        return 3
    except KeyboardInterrupt:
        raise
    except Exception as e:
        if not as_json:
            raise
        traceback.print_exc()  # plain text, for the log
        _error("internal", f"{type(e).__name__}: {e}", as_json)
        return 1


def _watch_stdin(cancel: threading.Event) -> None:
    """Set ``cancel`` when stdin says "cancel" or closes (the program that started us went away)."""

    def watch() -> None:
        try:
            for line in sys.stdin:
                if line.strip() == "cancel":
                    break
        except (OSError, ValueError):
            pass
        cancel.set()

    threading.Thread(target=watch, name="stdin-watch", daemon=True).start()


def _cmd_import(args: argparse.Namespace) -> int:
    as_json = args.progress == "json"
    cancel = threading.Event()
    if args.cancel_on_stdin:
        _watch_stdin(cancel)
    opts = ImportOptions(
        out_dir=Path(args.out),
        limit=args.limit,
        skip_spam_trash=args.skip_spam_trash,
        overwrite_local_labels=args.overwrite_local_labels,
        quiet=args.quiet,
        progress=args.progress,
        cancel=cancel,
    )
    result = None

    def run() -> int:
        nonlocal result
        result = run_import(args.paths, opts)
        return 0

    try:
        code = _run_reporting_errors(run, as_json)
    except KeyboardInterrupt:
        print("\ninterrupted; messages imported so far were saved. Re-run to continue.", file=sys.stderr)
        return 130
    if code or result is None:
        return code
    if result.status == "interrupted":
        if not as_json:
            print("stopped; messages imported so far were saved. Re-run to continue.", file=sys.stderr)
        return 130
    c = result.counts
    if not args.quiet and not as_json:
        print(
            f"{c['seen']:,} messages read in {result.seconds:.1f}s: {c['inserted']:,} new, "
            f"{c['labels_changed']:,} with changed labels, {c['unchanged']:,} unchanged, "
            f"{c['skipped']:,} skipped (spam/trash), {c['errors']:,} with parse errors.\n"
            f"{c['kept_local']:,} kept labels edited locally, {c['deleted_skipped']:,} skipped as deleted.\n"
            f"Output: {Path(args.out) / db.DB_FILENAME}"
        )
    return 0


def _cmd_scan(args: argparse.Namespace) -> int:
    def run() -> int:
        if args.json:
            _json_line(quick_look(args.paths))
            result = scan(args.paths, lambda done, total: _json_line(dict(type="progress", bytes_done=done, bytes_total=total)))
            _json_line(result.to_json())
            return 0
        result = scan(args.paths)
        print(f"Files:        {len(result.files):,}  ({_fmt_bytes(result.bytes_on_disk)} on disk)")
        print(f"Mbox files:   {len(result.mboxes):,}  ({_fmt_bytes(result.uncompressed_bytes)} uncompressed)")
        print(f"Messages:     {result.messages:,}")
        print(f"Date range:   {_fmt_date(result.first_date)} to {_fmt_date(result.last_date)}")
        print(f"Owner:        {result.owner or '-'}")
        return 0

    return _run_reporting_errors(run, args.json)


def _cmd_upgrade(args: argparse.Namespace) -> int:
    def run() -> int:
        out = Path(args.out)
        path = out / db.DB_FILENAME
        if not path.exists():
            raise SourceError(f"no database at {path}")
        before = db.schema_version(path)
        db.connect(out).close()  # connecting runs the migrations
        if args.json:
            _json_line(dict(type="done", from_version=before, to_version=db.SCHEMA_VERSION))
        elif before == db.SCHEMA_VERSION:
            print(f"{path} is already at schema version {db.SCHEMA_VERSION}.")
        else:
            print(f"Upgraded {path} from schema version {before} to {db.SCHEMA_VERSION}.")
        return 0

    return _run_reporting_errors(run, args.json)


def _fmt_bytes(n: int | None) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return ""


def _fmt_date(ts: int | None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts is not None else "-"


def _cmd_stats(args: argparse.Namespace) -> int:
    path = Path(args.out) / db.DB_FILENAME
    if not path.exists():
        print(f"error: no database at {path}", file=sys.stderr)
        return 2
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    q = lambda sql: conn.execute(sql).fetchone()  # noqa: E731
    msgs, size, first, last = q("SELECT count(*), sum(size_bytes), min(coalesce(received_utc, date_utc)), max(coalesce(received_utc, date_utc)) FROM messages")
    threads = q("SELECT count(*) FROM threads")[0]
    att_n, att_size = q("SELECT count(*), sum(size_bytes) FROM attachments")
    version = int(q("SELECT value FROM meta WHERE key = 'schema_version'")[0])
    del_n, del_size, notes = 0, 0, 0
    if version >= 3:  # stats opens the database read-only, so an older archive isn't upgraded here
        del_n, del_size = q("SELECT count(*), sum(size_bytes) FROM attachments WHERE deleted_at IS NOT NULL")
        notes = q("SELECT count(*) FROM thread_notes")[0]
    errors = q("SELECT count(*) FROM messages WHERE parse_error IS NOT NULL")[0]
    unread, starred = q("SELECT sum(is_unread), sum(is_starred) FROM messages")
    print(f"Database:     {path}")
    print(f"Messages:     {msgs:,}  ({_fmt_bytes(size)} raw)")
    print(f"Date range:   {_fmt_date(first)} to {_fmt_date(last)}")
    print(f"Threads:      {threads:,}")
    deleted = f", {del_n:,} deleted ({_fmt_bytes(del_size)} freed)" if del_n else ""
    print(f"Attachments:  {att_n:,}  ({_fmt_bytes(att_size)}){deleted}")
    print(f"Notes:        {notes:,}")
    print(f"Unread:       {unread or 0:,}   Starred: {starred or 0:,}")
    print(f"Parse errors: {errors:,}")
    rows = conn.execute(
        "SELECT l.name, count(*) n FROM labels l JOIN message_labels ml ON ml.label_id = l.id GROUP BY l.id ORDER BY n DESC"
    ).fetchall()
    print(f"Labels ({len(rows)}):")
    for name, n in rows[: args.labels]:
        print(f"  {n:>9,}  {name}")
    if len(rows) > args.labels:
        print(f"  ... {len(rows) - args.labels} more (use --labels N)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="gmail2sqlite", description="Convert a Gmail Takeout export into SQLite.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    imp = sub.add_parser("import", help="import .mbox / .mbox.gz / .tgz / .zip files (or folders containing them)")
    imp.add_argument("paths", nargs="+", metavar="TAKEOUT_PATH")
    imp.add_argument("--out", default=DEFAULT_OUT, help=f"output folder for mail.db and attachments/ (default {DEFAULT_OUT})")
    imp.add_argument("--limit", type=int, help="stop after reading N messages (for trying it out)")
    imp.add_argument("--skip-spam-trash", action="store_true", help="don't import new messages labeled Spam or Trash")
    imp.add_argument(
        "--overwrite-local-labels",
        action="store_true",
        help="replace labels edited in a viewer with the labels from this export",
    )
    imp.add_argument("--quiet", action="store_true", help="no progress line or summary")
    imp.add_argument(
        "--progress",
        choices=("auto", "json", "none"),
        default="auto",
        help="auto: a progress line on a terminal; json: JSON lines on stdout, for programs; none: nothing",
    )
    imp.add_argument(
        "--cancel-on-stdin",
        action="store_true",
        help="stop cleanly when stdin reads 'cancel' or closes (for programs that run the import)",
    )
    imp.set_defaults(func=_cmd_import)

    sc = sub.add_parser("scan", help="read the inputs without importing: size, message count, dates and owner")
    sc.add_argument("paths", nargs="+", metavar="TAKEOUT_PATH")
    sc.add_argument("--json", action="store_true", help="JSON lines on stdout: files, then progress, then the result")
    sc.set_defaults(func=_cmd_scan)

    up = sub.add_parser("upgrade", help="upgrade an archive to the current schema version without importing")
    up.add_argument("--out", default=DEFAULT_OUT, help=f"archive folder (default {DEFAULT_OUT})")
    up.add_argument("--json", action="store_true", help="print the result as a JSON line")
    up.set_defaults(func=_cmd_upgrade)

    st = sub.add_parser("stats", help="summarize an existing archive")
    st.add_argument("--out", default=DEFAULT_OUT, help=f"archive folder (default {DEFAULT_OUT})")
    st.add_argument("--labels", type=int, default=30, help="how many labels to list (default 30)")
    st.set_defaults(func=_cmd_stats)
    return p


def _sigterm_as_interrupt() -> None:
    """Treat SIGTERM like Ctrl-C, so an import that is killed still saves its work and closes cleanly."""

    def handler(signum, frame):
        raise KeyboardInterrupt

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, handler)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _sigterm_as_interrupt()
    return args.func(args)
