# Archive format (schema version 2)

This is the contract between `gmail2sqlite` and anything that reads its output,
such as the web interface. The output folder is self-contained and can be moved
as a unit:

```
gmail-archive/
  mail.db                 SQLite database (WAL mode)
  attachments/{bucket}/{gmail_id}/{NN}-{filename}
```

All paths stored in the database are relative to this folder and use `/`.
`meta.schema_version` holds the schema version; readers should check it.

## Conventions

- Timestamps are integer Unix epoch seconds, UTC.
- Booleans are `0`/`1` integers.
- Email addresses (`from_addr`, `addr` in JSON) are lower-cased. Display names are decoded to Unicode.
- Address lists are JSON arrays: `[{"name": "Alice", "addr": "alice@example.com"}]`. `name` may be `""`. A missing header is `NULL`, not `[]`.
- All text is UTF-8, decoded from whatever charset the message used. Line endings are `\n`.

## `messages`: one row per message

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | internal row ID; used as the foreign key everywhere and as `messages_fts.rowid` |
| `gmail_id` | TEXT UNIQUE | Gmail's message ID (decimal string, from the mbox `From ` line). For non-Takeout mboxes: `sha256-<hex of the raw message>` |
| `thread_id` | TEXT | Gmail thread ID (`X-GM-THRID`). Never `NULL`: when the header is missing it is the message's own `gmail_id` (Gmail's thread ID is its first message's ID) |
| `message_id` | TEXT | `Message-ID` header, with `<>`. May be missing or duplicated; don't use it as a key |
| `in_reply_to`, `references_hdr` | TEXT | raw header values |
| `subject` | TEXT | decoded |
| `from_name`, `from_addr` | TEXT | first `From` address |
| `to_json`, `cc_json`, `bcc_json`, `reply_to_json` | TEXT (JSON) | address lists |
| `date_utc` | INTEGER | from the `Date` header (the sender's clock); `NULL` if missing or unparseable |
| `date_raw` | TEXT | the `Date` header as written |
| `received_utc` | INTEGER | Gmail's internal date (from the mbox `From ` line). **Sort by `coalesce(received_utc, date_utc)`**, which is what Gmail shows |
| `snippet` | TEXT | first ~200 characters of the text, whitespace collapsed |
| `body_text` | TEXT | all inline `text/plain` parts, joined; `NULL` if none |
| `body_html` | TEXT | all inline `text/html` parts, joined; **unsanitized**. Sanitize before display, and rewrite `cid:` URLs using `attachments.content_id` |
| `headers_raw` | TEXT | the full original header block, for "show original" |
| `size_bytes` | INTEGER | size of the raw message |
| `has_attachments` | INTEGER | 1 if any row exists in `attachments` (including inline images) |
| `is_unread`, `is_starred`, `is_important` | INTEGER | from the `Unread`, `Starred`, `Important` labels, kept in sync with `message_labels` |
| `parse_error` | TEXT | `NULL` normally. Otherwise, newline-separated notes about what couldn't be decoded; the row still has everything that could be |
| `import_id` | INTEGER | the `imports` row that first stored this message |
| `labels_edited_at` | INTEGER | set by a viewer when it changes this message's labels; imports then keep those labels (see below) |

Indexes: `(thread_id, received_utc, date_utc)`, `received_utc`, `date_utc`, `from_addr`, `message_id`.

**Performance note for readers:** rows hold full bodies, so scanning `messages` reads
the whole database. Filter through indexes (`message_labels(label_id, message_id)`,
the thread index) rather than on columns such as `is_unread`.

## `labels` and `message_labels`

- `labels(id, name)`: names exactly as in `X-Gmail-Labels`. Nested labels keep their `Parent/Child` form. System labels include `Inbox`, `Sent`, `Drafts`, `Spam`, `Trash`, `Archived`, `Unread`, `Opened`, `Starred`, `Important`, `Chat` and `Category Personal`/`Promotions`/`Social`/`Updates`/`Forums`.
- `message_labels(message_id, label_id)`: primary key `(message_id, label_id)`, plus an index on `(label_id, message_id)`.

On re-import, a message's label set is **replaced** with the one in the newer export, unless `labels_edited_at` is set, in which case the local labels are kept. `gmail2sqlite import --overwrite-local-labels` makes the export win and clears `labels_edited_at`.

## `attachments`: one row per non-body MIME part

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `message_id` | INTEGER | → `messages.id` |
| `part_index` | INTEGER | 1-based order within the message; unique per message |
| `filename` | TEXT | original name, decoded, **unsanitized** (display only). `NULL` if the part had none |
| `path` | TEXT | file location relative to the archive folder. The stored filename is sanitized |
| `content_type` | TEXT | e.g. `application/pdf` |
| `size_bytes`, `sha256` | | of the decoded file |
| `content_id` | TEXT | `Content-ID` without `<>`; matches `cid:` URLs in `body_html` |
| `is_inline` | INTEGER | 1 for inline parts (usually images embedded in the HTML) |

Files on disk are **decoded** (not base64) and can be served directly with
`content_type`. `bucket` is the first two hex digits of `sha1(gmail_id)`.
Attached emails (`message/rfc822`) are saved as `.eml` files; their contents are
not mixed into the parent message's body.

## `threads`: rebuilt after every import

`thread_id` PK, `subject` (of the earliest message), `first_date`, `last_date`
(both `coalesce(received_utc, date_utc)`), `message_count`, `participants_json`
(a JSON array of distinct sender addresses), `labels_json` (a JSON array of
every label on any message in the thread). Index on `last_date`.

Labels are stored **per message**, as Gmail records them. Gmail's UI works
**per thread**: a thread appears under a label if any of its messages has it.
Use `threads.labels_json` (or join through `thread_id`) to match that. This also
explains Takeout's per-label files: `Inbox.mbox` contains whole threads, so
some of its messages don't carry the `Inbox` label themselves.

## `messages_fts`: full-text search

FTS5 table with columns `subject`, `people` (names and addresses from From/To/Cc/Bcc),
`body` (plain text, or text extracted from HTML when there's no plain part;
capped at 500,000 characters) and `attachment_names`. `rowid = messages.id`.

It's **contentless** (`content=''`, `contentless_delete=1`): it stores only the
index, not a second copy of the text. Rows can be deleted with
`DELETE FROM messages_fts WHERE rowid = ?` (needs SQLite 3.43+). So you can `MATCH` and use `rank`/`bm25()`, but
`snippet()`/`highlight()` return nothing; highlight in the UI instead.

```sql
SELECT m.* FROM messages m
WHERE m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice AND people:alice')
ORDER BY coalesce(m.received_utc, m.date_utc) DESC;
```

Tokenizer: `unicode61 remove_diacritics 2`, so `cafe` matches `café`.

## `message_list` (view)

Readable summary for Datasette and ad-hoc SQL: `id`, `received` (ISO datetime
text), `from_name`, `from_addr`, `subject`, `snippet`, `labels` (comma-joined),
`has_attachments`, `is_unread`, `is_starred`, `thread_id`.

## `deleted_messages`

`gmail_id` PK, `deleted_at`. Messages deleted on purpose (e.g. "Empty Trash" in a
viewer). Imports skip these IDs, so deleted mail doesn't come back.

## `imports` and `meta`

- `imports`: one row per run, with `started_at`, `finished_at`, `status` (`running`/`finished`/`interrupted`/`failed`), `sources_json`, `tool_version` and counters (`messages_seen`, `inserted`, `labels_changed`, `unchanged`, `skipped`, `errors`, `kept_local`, `deleted_skipped`).
- `meta(key, value)`: `schema_version`, `tool_version`, `last_import_at`. Viewers may add their own keys (e.g. `account_addresses`, a JSON array of the owner's addresses).

## Rules for writers (e.g. a viewer)

`gmail2sqlite` and a viewer both write to `mail.db`. Anything other than
`gmail2sqlite` that changes data must follow these rules so that later imports
behave:

1. **Connection settings:** `PRAGMA foreign_keys = ON` (per connection; needed for
   the `ON DELETE CASCADE`s) and a `busy_timeout` of a few seconds (an import may
   be running). The database is in WAL mode.
2. **Changing labels** of a message: update `message_labels`, keep
   `is_unread` / `is_starred` / `is_important` equal to whether the message has
   `Unread` / `Starred` / `Important`, and set `labels_edited_at` to the current time.
3. **Takeout pseudo-labels** come in pairs; keep them consistent:
   `Unread` ⟷ `Opened` (exactly one of the two) and `Inbox` ⟷ `Archived`
   (removing `Inbox` adds `Archived` and vice versa).
4. **Deleting a message:** in one transaction, insert its `gmail_id` into
   `deleted_messages`, `DELETE FROM messages_fts WHERE rowid = id`, and delete the
   `messages` row (labels and attachment rows cascade). After committing, delete its
   folder `attachments/{bucket}/{gmail_id}/`.
5. **`threads`** is derived. After changing labels or deleting messages, recompute
   the affected rows (delete the row if the thread has no messages left), using the
   same definitions as above.
