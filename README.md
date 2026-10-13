# Email Shoebox

Keep your old emails in a shoebox. Email Shoebox stores old emails (especially from Gmail) in SQLite on your own computer, and lets you read them in a friendly, familiar interface.

- Start with a backup of your Gmail data taken with [Google Takeout](https://takeout.google.com/).
- The importer turns that backup into a SQLite database plus a folder of attachments.
- The viewer shows it the way Gmail would, with your labels, messages grouped into threads, and the usual search features.

Everything runs locally on your machine. Nothing gets sent anywhere. The point is to archive an old email account for posterity in a form you can easily navigate. There is no Compose feature.

Bonus features:

- Speed. Alactrity. Um, fastness. Since everything is local, navigating around your email and attachments is nice and zippy!
- See stats (who you emailed the most, and so on).
- Look through every image attached to any email.
- Review attachments by type and size. All your attachments are kept on your hard drive, but if there are large ones you don't need, you can delete them _without deleting the email thread_. You can't do this in Gmail.
- Gmail keyboard shortcuts work.
- Gmail advanced search syntax works.
- Add notes to a thread. Click the Note icon, write some commentary, and it saves automatically, locally. Search covers your notes as well as emails, and `note:something` searches only notes.

What if you have an .mbox file that is not from Gmail/Google Takeout? I bet that would work, too, but I haven't tried it.

## Get started

1. **Get a backup from Google Takeout.** Go to https://takeout.google.com/, uncheck everything, and check Mail. You can click "All Mail data included" to limit what gets exported, or leave it all. Submit the request and wait for the email saying it's ready (possibly the next day). Download the `.zip` or `.tgz` file. You don't need to unzip it.
2. **Install Email Shoebox.** Download the installer for your computer from the [releases page](https://github.com/dkurth/email-shoebox/releases):
   - **macOS:** the `.dmg` (`mac-arm64` for Apple Silicon, `mac-x64` for Intel). Open it and drag Email Shoebox to Applications.
   - **Windows:** `Email-Shoebox-Setup-….exe`. It installs for you alone, without administrator rights.
   - **Linux:** the `.AppImage`, or the `.deb` for Debian and Ubuntu.
3. **Open it and choose your backup:** the `.zip` or `.tgz` file, an `.mbox` file, or a folder of them. (Takeout splits a large export into several files, `…-001.zip`, `…-002.zip` and so on: choose them all.) Email Shoebox reads it and suggests a name for the collection, such as "me@example.com (2004–2024)". Click Import and watch the progress bar. A large mailbox takes a while; you can stop and continue later.
4. **Read your mail.** Each backup you import becomes its own collection. Use the menu next to the Archive stats button to switch collections, import another backup, or manage them (rename, add a newer backup of the same account, show in Finder, delete).

Your collections are stored in Email Shoebox's folder (`~/Library/Application Support/Email Shoebox` on macOS, `%APPDATA%\Email Shoebox` on Windows, `~/.config/Email Shoebox` on Linux), or in another folder you choose when you import. Uninstalling the app keeps them (the Windows uninstaller asks; No is the default).

**macOS says the app "could not be verified"?** The app isn't signed with an Apple Developer ID yet, so macOS asks you to allow it once. Try to open it, click Done, then go to **System Settings → Privacy & Security**, scroll down, click **Open Anyway** and enter your password. Until the app is signed, it also can't update itself on macOS: it tells you when a new version is out, and you download it again.

## Questions

- **When I empty the trash, does the database get smaller? Does it delete the attachment files?**
  - **Attachment files: yes.** Emptying the Trash deletes each deleted message's attachment folder.
  - **The database: no**, not by itself. SQLite keeps the freed space inside `mail.db` for reuse. Use Archive stats → Maintenance → **Compact database** in the viewer to shrink the file (about 10 seconds per GB). The Overview tab shows how much free space is inside `mail.db`.

## What's in this repo

| Folder | What |
|---|---|
| [`app/`](app) | The desktop app (Electron). It bundles the other two, with its own copy of Python, so users don't need Python, Node or the command line. |
| [`importer/`](importer) | `gmail2sqlite`, the importer (Python, standard library only). Its [SCHEMA.md](importer/SCHEMA.md) is the archive format. |
| [`viewer/`](viewer) | The viewer (Node + Hono server, React front end). |

## Without the desktop app: the importer and the viewer on the command line

The importer and the viewer also work on their own, for example on a server or with other tools.

1. **Install the importer** (needs [uv](https://docs.astral.sh/uv/)):

   ```sh
   uv tool install -e importer      # puts `gmail2sqlite` on your PATH
   ```

2. **Import** a backup: a `.zip` or `.tgz` from Takeout, an `.mbox` file, or a folder (every mbox file in it is imported). Importing more files into the same archive later adds to it.

   ```sh
   gmail2sqlite import ~/Downloads/takeout-20261008T000000Z-001.zip --out data/my-archive
   gmail2sqlite stats --out data/my-archive      # did it work?
   ```

3. **Read it** (needs Node 24 or later):

   ```sh
   cd viewer
   npm install                          # once
   npm start -- ../data/my-archive      # opens http://127.0.0.1:5178/
   ```

You can also browse the raw tables with datasette: `uvx datasette@0.65.5 data/my-archive/mail.db -m importer/datasette.yml -o`.

The desktop app's collections are ordinary archives, so these commands work on them too (`--out` is the collection's folder).

See [importer/README.md](importer/README.md) and [viewer/README.md](viewer/README.md) for details.

## Development

The desktop app runs from source like this (needs Node 24 or later):

```sh
(cd viewer && npm install)
cd app
npm install
npm run fetch-python     # optional: the Python the app bundles (else it uses python3 from your PATH)
npm start                # builds into app/dist and starts the app
```

Tests:

| | |
|---|---|
| `cd importer && uv run python -m pytest` | the importer |
| `cd viewer && npm test && npm run e2e` | the viewer (Vitest; Playwright) |
| `cd app && npm test` | the app's collections, imports and server, with the real importer |
| `cd app && npm run build && npm run e2e` | the whole app in Electron (Playwright). Its windows stay hidden; add `SHOEBOX_HIDDEN_WINDOWS=0` to watch them. |

**Installers:** `cd app && npm run dist` makes the installer for your computer in `app/release`. `node scripts/dist.ts --mac --arm64 --x64` makes both macOS versions. The **Release** workflow on GitHub makes them for macOS, Windows and Linux; push a tag such as `v0.1.0` to upload them to a draft release. [`app/scripts/dist.ts`](app/scripts/dist.ts) explains macOS signing.
