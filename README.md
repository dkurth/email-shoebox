# Email Shoebox

Keep your old emails in a shoebox. Email Shoebox stores old emails (especially from Gmail) in SQLite on your own computer, and lets you read them in a friendly, familiar interface.

- Start with a backup of your Gmail data taken with [Google Takeout](https://takeout.google.com/).
- The importer turns that backup into a SQLite database plus a folder of attachments.
- The viewer shows it the way Gmail would, with your labels, threads and search.

Everything runs locally on your machine. Nothing gets sent anywhere. The point is to archive an old email account for posterity in a form you can easily navigate. There is no Compose feature.

Bonus features:

- See stats (who you emailed the most, and so on).
- Look through every image attached to any email.
- Review attachments by type and size. All your attachments are kept on your hard drive, but if there are large ones you don't need, you can delete them _without deleting the email thread_. You can't do this in Gmail.
- Gmail keyboard shortcuts work.
- Gmail advanced search syntax works.
- Add notes to a thread. Click the Note icon, write some commentary, and it saves automatically, locally. Search covers your notes as well as emails, and `note:something` searches only notes.

## What's in this repo

| Folder | What |
|---|---|
| [`importer/`](importer) | `gmail2sqlite`, the importer (Python, standard library only). Its [SCHEMA.md](importer/SCHEMA.md) is the archive format. |
| [`viewer/`](viewer) | The viewer (Node + Hono server, React front end). |
| `app/` | The desktop app (Electron), coming next. It bundles the other two, so users don't need Python, Node or the command line. |

## Getting started (command line)

1. **Request a Google Takeout backup.** Go to https://takeout.google.com/, uncheck everything, and check Mail. You can click "All Mail data included" to limit what gets exported, or leave it all. Submit the request and wait for the email saying it's ready (possibly the next day).
2. **Download and unzip it.** For example, you get a folder `Takeout-20261008` containing `Mail/`, with one `.mbox` file per folder or label (`Inbox.mbox` and so on).
3. **Install the importer** (needs [uv](https://docs.astral.sh/uv/)):

   ```sh
   uv tool install -e importer      # puts `gmail2sqlite` on your PATH
   ```

4. **Import** the mbox files. Pass a folder to import every mbox file in it. Importing more files into the same archive later adds to it.

   ```sh
   gmail2sqlite import Takeout-20261008/Mail --out data/my-archive
   gmail2sqlite stats --out data/my-archive      # did it work?
   ```

5. **Read it** (needs Node 24 or later):

   ```sh
   cd viewer
   npm install                          # once
   npm start -- ../data/my-archive      # opens http://127.0.0.1:5178/
   ```

You can also browse the raw tables with datasette: `uvx datasette@0.65.5 data/my-archive/mail.db -m importer/datasette.yml -o`.

See [importer/README.md](importer/README.md) and [viewer/README.md](viewer/README.md) for details.

## Questions

- **When I empty the trash, does the database get smaller? Does it delete the attachment files?**
  - **Attachment files: yes.** Emptying the Trash deletes each deleted message's attachment folder.
  - **The database: no**, not by itself. SQLite keeps the freed space inside `mail.db` for reuse. Use Archive stats → Maintenance → **Compact database** in the viewer to shrink the file (about 10 seconds per GB). The Overview tab shows how much free space is inside `mail.db`.
