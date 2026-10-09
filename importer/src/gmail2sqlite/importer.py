"""Wire it together: stream messages, skip known ones, parse, save attachments, write rows."""

from __future__ import annotations

import errno
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

from . import db
from .attachments import save_attachment
from .mbox_stream import RawMessage, iter_messages
from .parse import labels_from_raw, parse_message
from .sources import Progress, expand_paths, iter_mbox_streams

BATCH_SIZE = 1000
SPAM_TRASH = {"Spam", "Trash"}


@dataclass
class ImportOptions:
    out_dir: Path
    limit: int | None = None
    skip_spam_trash: bool = False
    overwrite_local_labels: bool = False
    quiet: bool = False


@dataclass
class ImportResult:
    counts: dict[str, int] = field(
        default_factory=lambda: dict(
            seen=0, inserted=0, labels_changed=0, unchanged=0, skipped=0, errors=0, kept_local=0, deleted_skipped=0
        )
    )
    status: str = "running"
    seconds: float = 0.0


class _Reporter:
    """A single self-overwriting progress line on stderr."""

    def __init__(self, progress: Progress, counts: dict[str, int], enabled: bool, stream: TextIO = sys.stderr):
        self.progress, self.counts, self.stream = progress, counts, stream
        self.enabled = enabled
        self.start = time.monotonic()
        self._last = 0.0

    def tick(self, force: bool = False) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        if not force and now - self._last < 0.5:
            return
        self._last = now
        elapsed = max(now - self.start, 1e-6)
        done, total = self.progress.done, self.progress.total
        pct = 100 * done / total if total else 100.0
        rate = self.counts["seen"] / elapsed
        eta = (elapsed * (total - done) / done) if done else 0
        c = self.counts
        line = (
            f"{pct:5.1f}%  {done / 1e9:.2f}/{total / 1e9:.2f} GB  {c['seen']:,} msgs ({rate:,.0f}/s)  "
            f"new {c['inserted']:,}  errors {c['errors']:,}  ETA {_fmt_secs(eta)}"
        )
        self.stream.write("\r" + line.ljust(100))
        self.stream.flush()

    def done(self) -> None:
        if self.enabled:
            self.tick(force=True)
            self.stream.write("\n")
            self.stream.flush()


def _fmt_secs(s: float) -> str:
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _insert_new(w: db.Writer, out_dir: Path, raw: RawMessage, import_id: int) -> bool:
    """Parse and store one new message. Returns True if it was stored with a parse error."""
    pm = parse_message(raw.data)
    errors = list(pm.errors)

    saved = []
    for part in pm.attachments:
        try:
            saved.append((part, save_attachment(out_dir, raw.gmail_id, part)))
        except OSError as e:
            if e.errno == errno.ENOSPC:
                raise
            errors.append(f"attachment {part.index}: {type(e).__name__}: {e}"[:500])
        except ValueError as e:
            errors.append(f"attachment {part.index}: {e}"[:500])

    labels = set(pm.labels)
    mid = w.insert_message(
        dict(
            gmail_id=raw.gmail_id,
            thread_id=pm.thread_id or raw.gmail_id,  # Gmail's thread ID is its first message's ID
            message_id=pm.message_id,
            in_reply_to=pm.in_reply_to,
            references_hdr=pm.references,
            subject=pm.subject,
            from_name=pm.from_.name if pm.from_ else None,
            from_addr=pm.from_.addr if pm.from_ else None,
            to_json=db.to_json(pm.to),
            cc_json=db.to_json(pm.cc),
            bcc_json=db.to_json(pm.bcc),
            reply_to_json=db.to_json(pm.reply_to),
            date_utc=pm.date_utc,
            date_raw=pm.date_raw,
            received_utc=raw.received_utc,
            snippet=pm.snippet,
            body_text=pm.body_text,
            body_html=pm.body_html,
            headers_raw=pm.headers_raw,
            size_bytes=len(raw.data),
            has_attachments=int(bool(pm.attachments)),
            is_unread=int("Unread" in labels),
            is_starred=int("Starred" in labels),
            is_important=int("Important" in labels),
            parse_error="\n".join(errors) or None,
            import_id=import_id,
        )
    )
    for part, s in saved:
        w.insert_attachment(
            dict(
                message_id=mid,
                part_index=part.index,
                filename=part.filename,
                path=s.path,
                content_type=part.content_type,
                size_bytes=s.size_bytes,
                sha256=s.sha256,
                content_id=part.content_id,
                is_inline=int(part.is_inline),
            )
        )
    w.set_labels(mid, pm.labels)

    w.insert_fts(
        mid,
        pm.subject or "",
        db.fts_people(
            pm.from_.name if pm.from_ else None,
            pm.from_.addr if pm.from_ else None,
            [(a.name, a.addr) for a in (*pm.to, *pm.cc, *pm.bcc)],
        ),
        pm.search_text,
        " ".join(p.filename for p in pm.attachments if p.filename),
    )
    return bool(errors)


def run_import(paths: list[str], opts: ImportOptions) -> ImportResult:
    files = expand_paths(paths)
    progress = Progress(files)
    conn = db.connect(opts.out_dir)
    w = db.Writer(conn)
    result = ImportResult()
    counts = result.counts
    import_id = w.start_import([str(f) for f in files])
    reporter = _Reporter(progress, counts, enabled=not opts.quiet and sys.stderr.isatty())
    started = time.monotonic()
    in_batch = 0
    deleted = w.deleted_ids()

    try:
        w.begin()
        for src in iter_mbox_streams(files, progress):
            for raw in iter_messages(src.stream):
                if opts.limit is not None and counts["seen"] >= opts.limit:
                    break
                counts["seen"] += 1

                existing = w.find_message(raw.gmail_id) if raw.gmail_id not in deleted else None
                if raw.gmail_id in deleted:
                    counts["deleted_skipped"] += 1  # deleted on purpose; don't bring it back
                elif existing is not None and existing["labels_edited_at"] and not opts.overwrite_local_labels:
                    counts["kept_local"] += 1  # labels edited in a viewer win
                elif existing is not None:
                    # Fast path: don't parse the body; just refresh labels.
                    if existing["labels_edited_at"]:
                        w.clear_local_edit(existing["id"])
                    if w.set_labels(existing["id"], labels_from_raw(raw.data)):
                        counts["labels_changed"] += 1
                    else:
                        counts["unchanged"] += 1
                else:
                    if opts.skip_spam_trash and SPAM_TRASH & set(labels_from_raw(raw.data)):
                        counts["skipped"] += 1
                    else:
                        w.savepoint()
                        try:
                            had_error = _insert_new(w, opts.out_dir, raw, import_id)
                        except BaseException:
                            w.rollback_savepoint()
                            raise
                        w.release()
                        counts["inserted"] += 1
                        counts["errors"] += had_error

                in_batch += 1
                if in_batch >= BATCH_SIZE:
                    w.update_import(import_id, "running", counts, finished=False)
                    w.commit()
                    w.begin()
                    in_batch = 0
                reporter.tick()
            else:
                continue
            break  # --limit reached
        result.status = "finished"
    except KeyboardInterrupt:
        result.status = "interrupted"
        raise
    except BaseException:
        result.status = "failed"
        raise
    finally:
        # Keep everything stored so far; the next run skips it.
        if not conn.in_transaction:
            w.begin()
        w.rebuild_threads()
        w.update_import(import_id, result.status, counts, finished=True)
        db.set_meta(conn, "last_import_at", str(int(time.time())))
        w.commit()
        conn.close()
        reporter.done()
        result.seconds = time.monotonic() - started
    return result
