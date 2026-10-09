"""Command line: ``gmail2sqlite import`` and ``gmail2sqlite stats``."""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

from . import __version__, db
from .importer import ImportOptions, run_import
from .sources import SourceError

DEFAULT_OUT = "./gmail-archive"


def _cmd_import(args: argparse.Namespace) -> int:
    opts = ImportOptions(
        out_dir=Path(args.out),
        limit=args.limit,
        skip_spam_trash=args.skip_spam_trash,
        overwrite_local_labels=args.overwrite_local_labels,
        quiet=args.quiet,
    )
    try:
        result = run_import(args.paths, opts)
    except SourceError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted; messages imported so far were saved. Re-run to continue.", file=sys.stderr)
        return 130
    c = result.counts
    if not args.quiet:
        print(
            f"{c['seen']:,} messages read in {result.seconds:.1f}s: {c['inserted']:,} new, "
            f"{c['labels_changed']:,} with changed labels, {c['unchanged']:,} unchanged, "
            f"{c['skipped']:,} skipped (spam/trash), {c['errors']:,} with parse errors.\n"
            f"{c['kept_local']:,} kept labels edited locally, {c['deleted_skipped']:,} skipped as deleted.\n"
            f"Output: {Path(args.out) / db.DB_FILENAME}"
        )
    return 0


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
    errors = q("SELECT count(*) FROM messages WHERE parse_error IS NOT NULL")[0]
    unread, starred = q("SELECT sum(is_unread), sum(is_starred) FROM messages")
    print(f"Database:     {path}")
    print(f"Messages:     {msgs:,}  ({_fmt_bytes(size)} raw)")
    print(f"Date range:   {_fmt_date(first)} to {_fmt_date(last)}")
    print(f"Threads:      {threads:,}")
    print(f"Attachments:  {att_n:,}  ({_fmt_bytes(att_size)})")
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
    imp.set_defaults(func=_cmd_import)

    st = sub.add_parser("stats", help="summarize an existing archive")
    st.add_argument("--out", default=DEFAULT_OUT, help=f"archive folder (default {DEFAULT_OUT})")
    st.add_argument("--labels", type=int, default=30, help="how many labels to list (default 30)")
    st.set_defaults(func=_cmd_stats)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
