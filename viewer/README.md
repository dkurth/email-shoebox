# local-gmail-viewer

A Gmail-like web viewer for a mail archive made by
[gmail2sqlite](../gmail2sqlite). It runs on your computer only: one command
starts a small local server and opens the Inbox in a browser tab.

You can read mail and change labels: archive, trash, star, add or remove
labels, mark read or unread, and permanently empty the Trash. There is no
compose, reply or send.

## Requirements

- **Node 24** or later (`node --version`).
- An archive folder made by **gmail2sqlite 0.3.0 or later** (it holds `mail.db`
  and `attachments/`). Older archives are upgraded by running
  `gmail2sqlite import` on them again.

## Usage

```sh
cd local-gmail-viewer
npm install                       # once
npm start -- ../gmail-archive     # starts the server and opens http://127.0.0.1:5178/
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

`npm link` adds a global `gmail-viewer` command: `gmail-viewer ~/gmail-archive`.

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
  headers and decoded parts. **Click an attachment to download it.**
- **Opening a conversation marks it read.**
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
| `g` then `i`/`s`/`t`/`a`/`d` | go to Inbox / Starred / Sent / All Mail / Drafts |
| `?` | show all shortcuts |

Actions apply to the selected conversations, or to the one under the cursor
if none are selected, or to the open conversation.

**`y` depends on the view, as in Gmail:** Inbox: archive. A label or category:
remove that label. Starred: unstar. Important: mark not important. Trash: move
to Inbox. Spam: not spam. All Mail, Sent, Drafts and Chats: nothing.

### Your changes and later imports

The viewer writes to `mail.db`, following the rules in gmail2sqlite's
`SCHEMA.md`, so importing a newer Takeout export later works as expected:

- Messages you **deleted forever** are not imported again.
- Labels you **changed** here are kept (`gmail2sqlite import --overwrite-local-labels`
  makes the export win instead).

It's safe to keep a copy of the archive folder as a backup before big changes.

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
- Attachment files are served only from the archive's `attachments/` folder.

## Development

```sh
npm run dev -- ../gmail-archive   # API server (restarts on change) + Vite (hot reload) at http://localhost:5173
npm test                          # Vitest: API, label rules, writes, Empty Trash, security
npm run e2e                       # Playwright: keyboard flows, HTML safety, downloads (first: npx playwright install chromium)
npm run typecheck
```

Tests use a small synthetic archive committed in `test/fixtures/archive/` (no
real mail), so they run without gmail2sqlite installed. After a change to the
archive format, rebuild it with `test/fixtures/rebuild-archive.sh` (this needs
the `gmail2sqlite` command) and commit the result.

Layout: `server/` (Hono + better-sqlite3; Node runs the TypeScript directly),
`web/` (React + Vite), `shared/` (label rules and API types used by both),
`test/`.
