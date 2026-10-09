# Gmail Shoebox

Back up your old emails and be able to look through them locally in a familiar interface similar to Gmail.

- Start with a backup of your Gmail data taken with <a href="https://takeout.google.com/">Google Takeout</a>.
- Use <a href="https://github.com/dkurth/gmail2sqlite/">gmail2sqlite</a> to turn that backup into a SQLite database.
- Then use Gmail Shoebox to look through the emails

Bonus features:

- See stats (who did you email the most, etc.)
- Look through every image attached to any email
- Review attachments by type and size. All your attachments are kept on your hard drive, but if there are large ones you don't need, you can delete them _without having to delete the email thread_. This is something you can't do in Gmail.
- Gmail keyboard shortcuts still work
- Gmail advanced search syntax still works
- Add notes to a thread. Maybe you want to leave a bit of commentary on something. You can click a Note icon, add a note to a thread, and it is saved locally. Search results will search your notes as well as emails. You can also search for `note:something` to search the content of notes explicitly. They save automatically.

Gmail Shoebox runs locally on your machine, in a browser. Nothing gets sent anywhere. The point of it is to let you archive an old email account for posterity in a form you can easily navigate. There is obviously no Compose feature.

## Requirements

- **Node 24** or later (`node --version`).
- An archive folder made by **gmail2sqlite 0.3.0 or later** (it holds `mail.db`
  and `attachments/`). Older archives are upgraded by running
  `gmail2sqlite import` on them again.

## Usage

```sh
cd gmail-shoebox
npm install                             # run this once
# Assuming `../data/gmail-archive` contains the mail.db file from gmail2sqlite:
npm start -- ../data/gmail-archive      # starts the server and opens http://127.0.0.1:5178/
```

The first start builds the web front end, which takes a few seconds. Press Ctrl-C to stop.

Options (after `--`):

| Option | |
|---|---|
| `ARCHIVE_DIR` | the archive folder; default `./gmail-archive` |
| `--port N` | default 5178; the next free port is used if it's taken |
| `--no-open` | don't open a browser tab |
| `--read-only` | open the archive read-only: no label changes, no deletes, and opening a thread doesn't mark it read |
| `--me ADDR` | your address, shown as "me" (normally found from your Sent mail; remembered in the archive) |

# Everything from here down was written by AI and may/may not be helpful to you

## What it does

- **Sidebar:** Inbox, Starred, Important, Sent, Drafts, Chats, All Mail, Spam
  and Trash (with unread counts, as Gmail shows them), a collapsed Categories
  group, then your labels as a tree (`Parent/Child`). Hover a label and click
  ⋮ to change its color or delete it (the messages stay).
- **Label colors:** Takeout doesn't include the colors you chose in Gmail, so
  each label gets one from a fixed palette, picked from its name. A nested
  label uses its parent's color until you choose one. Chosen colors are saved
  in the archive (`meta.viewer_label_colors`), and imports leave them alone.
- **List:** one row per conversation, newest first, 50 per page, as in Gmail.
  A conversation is in a folder or label if any of its messages is. Mail in
  Spam or Trash is hidden everywhere else.
- **Conversation:** every message, oldest first. Read messages are collapsed,
  and unread ones plus the last one are expanded. Each message shows its sender
  and recipients; ▾ shows From/To/Cc/Bcc/Date. "Show original" shows the
  headers and decoded parts.
- **Attachments:** images show as thumbnails; click one for a full-screen
  viewer (←/→ between the message's images, Esc closes). Audio and video play
  in the page. PDFs and text files open in a new tab. Anything else downloads
  when you click it. SVG and HTML attachments are never shown in the browser.
- **Opening a conversation marks it read.**
- **Notes:** the note button at the right of the toolbar opens a panel where
  you can write a plain-text note about the conversation. **It saves itself**:
  1 second after you stop typing, at once when you leave the conversation,
  and when you close or reload the page. If another window changed the same
  note, you choose "Keep mine" or "Use theirs". A conversation with a note shows
  a note icon in the list, and the **Notes** folder (under Trash) lists every
  conversation with a note, newest note first. Notes are stored in `mail.db`
  (`thread_notes`), and imports never change them. Export them all from the
  admin page (Markdown or CSV).
- **Search:** the box at the top (or `/`) takes Gmail's search syntax:
  `from:`, `to:`, `subject:`, `label:`, `in:`, `is:unread`, `has:attachment`,
  `filename:`, `before:`/`after:`, `larger:`, `list:`, quoted phrases, `-` to
  leave out, `OR`, and more. Plain words also match your notes; `note:` searches
  only notes; `word*` finds words that start with `word`. Click **ⓘ** in the
  search box for every option. Matching words are highlighted, and each row
  shows the text around the first match. Trash and Spam are left out unless
  you search with `in:trash`, `in:spam` or `in:anywhere`.
- **Archive stats** (📊 at the top, or `g` then `z`):
  - *Overview*: counts and sizes, the date range, space on disk, parse errors,
    notes (with the export links), the top senders and every label.
  - *People*: everyone you sent to and received from (click an address to
    search, a name for a page about that person), grouped by domain if you
    like, and your mailing lists.
  - *Attachments*: sizes by type and sender, and every attachment, biggest
    first, with filters. **Delete** one, the ones you check, or everything the
    filter matches. "Duplicates only" shows files stored more than once;
    **Merge duplicate files** turns the extra copies into hard links, which
    frees their space and keeps every attachment (see below).
  - *Images*: every image attachment in a grid, newest first.
  - *Imports*: every `gmail2sqlite import` run.
  - *Maintenance*: **Compact database**.
- **Deleting attachments:** from the attachment report, from the 🗑 on an
  attachment in a message, or with ⋮ → "Delete all attachments in this
  conversation". A dialog shows the names and sizes first. The file is
  removed, the email stays, and the attachment shows as "(deleted)".
- **Dark mode:** the 🌙 button at the top right turns dark mode on and off
  (highlighted when on). Your choice is remembered in this browser. Until you
  click it, the viewer follows your system setting.
- **Undo:** after archive, trash or a label change, a message at the bottom
  left offers **Undo** (or press `z`). Star and unstar show no message: the
  star icon (in the list, and next to the subject of an open conversation)
  changes at once.
- **Empty Trash:** in Trash, "Empty Trash now" (or select conversations and
  "Delete forever"). A dialog shows how many messages, conversations and
  attachments will be deleted. **Confirmed deletes are permanent**: the rows
  and the attachment files are removed.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | move down/up in the list; in a conversation, open the older/newer one |
| `x` | select the conversation under the cursor |
| `Enter` or `o` | open it |
| `u` or `Esc` | back to the list (`Esc` in the list clears the selection) |
| `#` | move to Trash (in Trash: delete forever, after a confirmation) |
| `y` | remove from this view, as in Gmail (see below) |
| `s` | star / unstar |
| `l` | Labels menu (filter, tick labels, or create one) |
| `Shift-i` / `Shift-u` | mark read / unread |
| `z` | undo |
| `g` then `i`/`s`/`t`/`a`/`d`/`z` | go to Inbox / Starred / Sent / All Mail / Drafts / Archive stats |
| `/` | search |
| `?` | show all shortcuts |

Actions apply to the selected conversations, or to the one under the cursor
if none are selected, or to the open conversation.

**`y` depends on the view, as in Gmail:** Inbox: archive. A label or category:
remove that label. Starred: unstar. Important: mark not important. Trash: move
to Inbox. Spam: not spam. Search results: archive. All Mail, Sent, Drafts,
Chats and Notes: nothing.

### Your changes and later imports

The viewer writes to `mail.db`, following the rules in gmail2sqlite's
`SCHEMA.md`, so importing a newer Takeout export later works as expected:

- Messages you **deleted forever** are not imported again. Deleting the last
  message of a conversation also deletes its note.
- Labels you **changed** here are kept (`gmail2sqlite import --overwrite-local-labels`
  makes the export win instead).
- **Notes** are kept, and **deleted attachment files** are not written again.

It's safe to keep a copy of the archive folder as a backup before big changes.

### Disk space

- **Emptying the Trash deletes the attachment files**, but `mail.db` doesn't get
  smaller: SQLite keeps the freed space inside the file for reuse. Archive
  stats → Maintenance → **Compact database** rewrites it without that space
  (about 10 seconds per GB).
- **Merge duplicate files** (Archive stats → Attachments → Duplicates only)
  replaced 8,558 extra copies with hard links on a 126,000-message archive and
  freed 2.3 GB, in 9 seconds. The merged copies are one file on disk; nothing
  in the viewer changes files, but a program that edits one copy in place
  would change all of them. **To copy the archive folder to another disk, use
  `ditto` or `rsync -aH`**: they keep hard links. `cp -R` and `rsync -a` (no
  `-H`) store each copy in full again. (Finder and Time Machine were not tested.)

## Safety

- The server listens on `127.0.0.1` only. It rejects requests with another
  `Host` header (DNS rebinding) and writes from any other origin, so other
  websites can't read or change your mail through it.
- Email HTML is stored exactly as it was sent. The viewer removes scripts and
  other active content (DOMPurify), and shows the result in a sandboxed frame
  that can't run scripts.
- **Images from the internet are blocked** until you click "Show images in
  this message", so tracking pixels can't report that you opened old mail.
  Embedded images (`cid:`) are shown from the archive.
- Attachment files are served only from the archive's `attachments/` folder,
  with `nosniff` and a policy that stops any script. Only images, audio,
  video, PDFs and plain text are shown in the browser; text is always sent as
  `text/plain`, so an attached web page shows as text.

## Development

```sh
npm run dev -- ../gmail-archive   # API server (restarts on change) + Vite (hot reload) at http://localhost:5173
npm test                          # Vitest: API, label rules, writes, notes, search, admin, attachments, security
npm run e2e                       # Playwright: keyboard flows, HTML safety, notes, search, admin pages (first: npx playwright install chromium)
npm run typecheck
```

Tests use a small synthetic archive committed in `test/fixtures/archive/` (no
real mail), so they run without gmail2sqlite installed. After a change to the
archive format, rebuild it with `test/fixtures/rebuild-archive.sh` (this needs
the `gmail2sqlite` command) and commit the result.

Layout: `server/` (Hono + better-sqlite3; Node runs the TypeScript directly),
`web/` (React + Vite), `shared/` (label rules and API types used by both),
`test/`.
