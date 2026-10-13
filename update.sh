#!/bin/sh
# Build Email Shoebox from this checkout and install it in /Applications (macOS). See app/scripts/install-local.ts.
#   ./update.sh          build and install
#   ./update.sh --open   ...then start it
set -e
exec node "$(dirname "$0")/app/scripts/install-local.ts" "$@"
