#!/bin/sh
# Rebuild the committed test archive from synthetic mail.
# Uses the importer in this repo (../../../importer); needs uv.
set -eu
cd "$(dirname "$0")"
gmail2sqlite() { uv run --quiet --project ../../../importer gmail2sqlite "$@"; }
node make-sample-mbox.ts > sample.mbox
rm -rf archive
gmail2sqlite import sample.mbox --out archive --quiet
sqlite3 archive/mail.db "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" > /dev/null
gmail2sqlite stats --out archive
