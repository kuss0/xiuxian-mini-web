#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${MINIWEB_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${MINIWEB_DATA_DIR:-$ROOT_DIR/data}"
BACKUP_DIR="${MINIWEB_BACKUP_DIR:-$ROOT_DIR/backups}"
KEEP_DAYS="${MINIWEB_BACKUP_KEEP_DAYS:-14}"
KEEP_COUNT="${MINIWEB_BACKUP_KEEP_COUNT:-3}"
REQUIRED_FREE_BYTES="${MINIWEB_BACKUP_REQUIRED_FREE_BYTES:-}"

DB_PATH="$DATA_DIR/miniweb.db"
STAMP="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_DIR/miniweb-$STAMP.tar.gz"
TMP_DIR=""

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

available_bytes() {
  df -PB1 "$1" | awk 'NR == 2 {print $4}'
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  rm -f "$DEST.tmp"
}

sqlite_backup() {
  local src="$1"
  local dst="$2"
  sqlite3 "$src" ".timeout 30000" ".backup main $dst"
  sqlite3 "$dst" "PRAGMA quick_check;" | grep -qx "ok"
}

prune_backups() {
  if [[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_DAYS" -gt 0 ]]; then
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'miniweb-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
  fi
  if [[ "$KEEP_COUNT" =~ ^[0-9]+$ && "$KEEP_COUNT" -gt 0 ]]; then
    ls -1t "$BACKUP_DIR"/miniweb-*.tar.gz 2>/dev/null | sed -e "1,${KEEP_COUNT}d" | xargs -r rm -f
  fi
}

need_cmd sqlite3
need_cmd tar
need_cmd gzip

if [[ ! -s "$DB_PATH" ]]; then
  echo "missing database: $DB_PATH" >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
DB_BYTES="$(stat -c '%s' "$DB_PATH")"
if [[ -z "$REQUIRED_FREE_BYTES" ]]; then
  REQUIRED_FREE_BYTES=$((DB_BYTES * 2 + 1073741824))
fi
FREE_BYTES="$(available_bytes "$BACKUP_DIR")"
if [[ "$FREE_BYTES" -lt "$REQUIRED_FREE_BYTES" ]]; then
  echo "not enough free space for backup: free=${FREE_BYTES} required=${REQUIRED_FREE_BYTES}" >&2
  exit 1
fi
TMP_DIR="$(mktemp -d "$BACKUP_DIR/.tmp-miniweb-backup.XXXXXXXX")"
trap cleanup EXIT

mkdir -p "$TMP_DIR/data/sessions" "$TMP_DIR/meta"

sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(PASSIVE);" >/dev/null
sqlite_backup "$DB_PATH" "$TMP_DIR/data/miniweb.db"

if [[ -d "$DATA_DIR/sessions" ]]; then
  while IFS= read -r -d '' session_file; do
    session_name="$(basename "$session_file")"
    if ! sqlite_backup "$session_file" "$TMP_DIR/data/sessions/$session_name"; then
      cp -p "$session_file" "$TMP_DIR/data/sessions/$session_name"
    fi
  done < <(find "$DATA_DIR/sessions" -maxdepth 1 -type f -name '*.session' -print0)
fi

if [[ -s "$DATA_DIR/state.db" ]]; then
  sqlite_backup "$DATA_DIR/state.db" "$TMP_DIR/data/state.db"
elif [[ -e "$DATA_DIR/state.db" ]]; then
  : > "$TMP_DIR/data/state.db"
fi

{
  echo "created_at=$(date -Is)"
  echo "root=$ROOT_DIR"
  echo "source_db=$DB_PATH"
  echo "source_db_bytes=$DB_BYTES"
  echo "git_commit=$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  echo "hostname=$(hostname)"
} > "$TMP_DIR/meta/manifest.txt"

tar -C "$TMP_DIR" -czf "$DEST.tmp" data meta
gzip -t "$DEST.tmp"
tar -tzf "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"
ln -sfn "$(basename "$DEST")" "$BACKUP_DIR/latest-miniweb.tar.gz"
prune_backups

echo "$DEST"
