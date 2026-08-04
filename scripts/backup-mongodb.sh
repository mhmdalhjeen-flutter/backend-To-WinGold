#!/usr/bin/env bash
# Offers Tech — MongoDB backup (mongodump)
# Usage: ./scripts/backup-mongodb.sh [OUT_DIR]
# Requires: MONGO_URI in backend/.env or environment; MongoDB Database Tools on PATH.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$OUT_DIR/$TIMESTAMP"

if [[ -z "${MONGO_URI:-}" && -f "$ROOT/.env" ]]; then
  export MONGO_URI="$(grep -E '^\s*MONGO_URI=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\r')"
fi

if [[ -z "${MONGO_URI:-}" ]]; then
  echo "MONGO_URI is not set. Add it to backend/.env or export MONGO_URI." >&2
  exit 1
fi

if ! command -v mongodump >/dev/null 2>&1; then
  echo "mongodump not found. Install MongoDB Database Tools." >&2
  exit 1
fi

mkdir -p "$TARGET"
echo "Backing up to $TARGET ..."
mongodump --uri "$MONGO_URI" --gzip --out "$TARGET"
echo "Backup complete: $TARGET"
find "$TARGET" -name '*.bson.gz' | wc -l | xargs echo "Collection files:"
