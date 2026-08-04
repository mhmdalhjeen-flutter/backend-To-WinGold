#!/usr/bin/env bash
# Offers Tech — MongoDB restore (mongorestore)
# Usage: ./scripts/restore-mongodb.sh BACKUP_DIR [TARGET_DB]
#   BACKUP_DIR  path to timestamp folder from mongodump (contains <db_name>/)
#   TARGET_DB   optional; defaults to scratch DB <source>_restore_<timestamp>
# Requires: MONGO_URI in backend/.env; MongoDB Database Tools on PATH.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${1:?Usage: restore-mongodb.sh BACKUP_DIR [TARGET_DB]}"
TARGET_DB="${2:-}"

if [[ -z "${MONGO_URI:-}" && -f "$ROOT/.env" ]]; then
  export MONGO_URI="$(grep -E '^\s*MONGO_URI=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\r')"
fi

if [[ -z "${MONGO_URI:-}" ]]; then
  echo "MONGO_URI is not set. Add it to backend/.env or export MONGO_URI." >&2
  exit 1
fi

if ! command -v mongorestore >/dev/null 2>&1; then
  echo "mongorestore not found. Install MongoDB Database Tools." >&2
  exit 1
fi

SOURCE_DB="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | head -1 | xargs basename)"
if [[ -z "$SOURCE_DB" ]]; then
  echo "No database folder found inside $BACKUP_DIR" >&2
  exit 1
fi

if [[ -z "$TARGET_DB" ]]; then
  TARGET_DB="${SOURCE_DB}_restore_$(date +%Y%m%d-%H%M%S)"
  echo "Scratch restore target: $TARGET_DB"
fi

echo "Restoring $SOURCE_DB -> $TARGET_DB from $BACKUP_DIR ..."
mongorestore --uri "$MONGO_URI" --gzip --drop \
  --nsFrom "${SOURCE_DB}.*" --nsTo "${TARGET_DB}.*" \
  "$BACKUP_DIR"

echo "Restore complete. Target database: $TARGET_DB"
echo "Drop when done: mongosh \"\$MONGO_URI\" --eval \"db.getSiblingDB('$TARGET_DB').dropDatabase()\""
