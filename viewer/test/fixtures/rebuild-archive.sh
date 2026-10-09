#!/bin/sh
# Rebuild the committed test archive from synthetic mail.
# Needs the `gmail2sqlite` command on PATH (uv tool install -e path/to/gmail2sqlite).
set -eu
cd "$(dirname "$0")"
node make-sample-mbox.ts > sample.mbox
rm -rf archive
gmail2sqlite import sample.mbox --out archive --quiet
sqlite3 archive/mail.db "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" > /dev/null
gmail2sqlite stats --out archive
