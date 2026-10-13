# gmail2sqlite: the Email Shoebox importer

Turn a Gmail export (Google Takeout `.mbox`) into:

- **`mail.db`**: a SQLite database with one row per message (headers, decoded text and HTML bodies, Gmail labels and threads) and full-text search, and
- **`attachments/`**: every attachment and inline image as a normal, decoded file.

It streams the input, so a mailbox of any size works. Memory use depends on the
largest single message, not the mailbox size. It has no runtime dependencies
beyond Python 3.11+.

The output is read by the [Email Shoebox viewer](../viewer). [SCHEMA.md](SCHEMA.md)
documents the format.

## Install

```sh
cd importer
uv tool install -e .          # puts `gmail2sqlite` on your PATH
# or, without installing:  uv run gmail2sqlite ...
```

## Usage

### 1. Convert an mbox into SQLite

```sh
gmail2sqlite import ~/Downloads/Gmail-backup.mbox --out ./gmail-archive
```

This creates `./gmail-archive/mail.db` and `./gmail-archive/attachments/`.
On a TTY, a progress line shows percent done, messages/second and an ETA.

The input can be any mix of:

| Input | Example |
|---|---|
| a plain mbox | `All mail Including Spam and Trash.mbox` |
| a gzipped mbox | `mail.mbox.gz` |
| a Takeout archive (read in place, nothing extracted) | `takeout-20240425T000000Z-001.tgz`, `.tar.gz`, `.zip` |
| a folder (searched for all of the above) | `~/Downloads/Takeout/` |

Takeout exports either one `All mail Including Spam and Trash.mbox` or, if you
picked labels, one mbox per label (`Mail/Inbox.mbox`, `Mail/Starred.mbox`, …).
For the second form, pass the folder. A message that appears in several files
is stored once, with all its labels.

Useful options:

```sh
gmail2sqlite import INPUT --limit 1000         # try it on the first 1,000 messages
gmail2sqlite import INPUT --skip-spam-trash    # leave out new messages labeled Spam or Trash
gmail2sqlite stats --out ./gmail-archive       # counts, date range, labels
```

**Re-running is safe and fast.** Messages are keyed by Gmail's own message ID.
Already-imported messages aren't re-parsed; only their labels are refreshed. So:

- If an import is interrupted (Ctrl-C, crash), run the same command again to continue.
- To update the archive, import a newer Takeout export into the same `--out`. New
  messages are added and label changes (read, starred, moved) are applied. Messages
  you've since deleted from Gmail stay in the archive.
- Changes made in a viewer are kept: messages you deleted there aren't re-imported,
  labels you edited there aren't overwritten (use `--overwrite-local-labels`
  to let the export win), notes stay, and attachment files you deleted there
  aren't written again.
- A newer version of `gmail2sqlite` upgrades an older archive the first time it
  imports into it. The upgrade to schema version 3 reads every message once
  (about a minute for 125,000 messages).

Messages that can't be fully decoded are still stored, with whatever could be
read, and with a note in `messages.parse_error`. `stats` shows how many there are.

### 2. Browse it locally with Datasette (before there's a UI)

[Datasette](https://datasette.io) gives you a web page for exploring the
database: browse tables, full-text search, filter, facet, and run SQL. No install
is needed with `uv`:

```sh
uvx datasette@0.65.5 gmail-archive/mail.db -m datasette.yml -o
```

(`-o` opens your browser at http://127.0.0.1:8001. `datasette.yml` is in this repo
and sets up search and a few saved queries. Datasette 1.0 alphas use `-c`
instead of `-m`, hence the pinned version.)

Good places to start:

- **`message_list`**: every message, newest first, with readable dates and labels.
  Type in the search box for full-text search, or click a column to filter or facet.
- **Saved queries** (on the `mail` database page):
  - *Search mail*: full-text search with FTS5 syntax: `invoice`, `"exact phrase"`,
    `people:alice`, `subject:report`, `attachment_names:pdf`, `tax NOT spam`.
  - *Messages with a label*: e.g. `Inbox`, `Starred`, or one of your labels.
  - *A whole thread*: all messages with a given `thread_id`.
  - *Search notes*: full-text search in notes written in a viewer.
  - *Mailing lists*: messages per `List-Id`.
  - *Label counts*.
- **`messages`**: the full rows, including `body_text`, `body_html` (shown as
  text) and `headers_raw`. Click a message's `id` to see one message.
- **`attachments`**: each row links to its message. The `path` column is relative
  to `gmail-archive/`, so open a file with e.g. `open gmail-archive/attachments/...`.

Datasette is read-only by default and only listens on localhost.

You can also just use SQL:

```sh
sqlite3 gmail-archive/mail.db \
  "SELECT datetime(received_utc,'unixepoch'), from_addr, subject FROM messages
   WHERE id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'passport')
   ORDER BY received_utc DESC LIMIT 20"
```

### 3. Read it like Gmail

The [viewer](../viewer), in this same repo, is a Gmail-like viewer for these
archives that runs locally (`npm start -- ../gmail-archive`).
Its label changes, deletes, notes and deleted attachment files follow the
"Rules for writers" in SCHEMA.md, so later imports keep them.

## How it works

- `sources.py` opens each input as a byte stream (gzip and tar in streaming mode,
  zip members as streams). `mbox_stream.py` splits it into messages at `From `
  lines and undoes mbox `>From` escaping. Takeout's `From 1797184859426826706@xxx …`
  line carries Gmail's message ID and internal date.
- `parse.py` decodes each message with Python's `email` package. It handles
  encoded headers, raw UTF-8 headers, unknown or mislabeled charsets, broken MIME
  and attached emails, and never raises.
- `attachments.py` writes decoded files atomically with sanitized names (sender-chosen
  names like `../../x` can't escape the folder).
- `db.py` / `importer.py` write in batches of 1,000 messages (WAL mode), keep the
  FTS index in the same transactions, and rebuild `threads` at the end.

Memory: there's no growth with mailbox size, but while a large message is being
parsed, the parser briefly uses several times its size (a 30 MB message peaks
around 300 MB). With the allocator's caching, expect around 1 GB RSS on a mailbox
that contains 25 MB+ messages.

## Development

```sh
uv sync
uv run pytest              # synthetic fixtures; no real mail is in the repo
uv run pytest -m enron     # also import a public sample of 3,266 real Enron emails (downloads 6 MB once)
```

Prior art: [simonw/mbox-to-sqlite](https://github.com/simonw/mbox-to-sqlite), whose
Datasette workflow and Enron sample this borrows. It loads the whole mailbox into
memory and doesn't handle attachments, charsets or Gmail labels, so this is a
separate tool.
