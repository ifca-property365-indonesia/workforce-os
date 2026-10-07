#!/usr/bin/env bash
# Daily backup for a native (PM2) install: Postgres dump + uploaded files + .env.
#
# The .env copy matters: credentials in the database are encrypted with ENCRYPTION_KEY,
# so a dump restored without that key cannot decrypt SMTP passwords or integration secrets.
#
#   deploy/backup.sh                       # writes to $BACKUP_DIR (default /root/backups/workforce-os)
#   KEEP_DAYS=30 deploy/backup.sh
#   cron: 30 2 * * * /path/to/workforce-os/deploy/backup.sh >> /var/log/workforce-os-backup.log 2>&1
#
# Restore (as the app role, into an empty database whose extensions a superuser created first:
# CREATE EXTENSION vector; CREATE EXTENSION pgcrypto; — the two "must be owner of extension" errors are harmless):
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" wfos-<stamp>.dump
#   tar -xzf wfos-<stamp>-uploads.tar.gz -C <app dir>/storage
#   cp wfos-<stamp>.env <app dir>/.env
set -euo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/workforce-os}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

set -a
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a
: "${DATABASE_URL:?DATABASE_URL missing in .env}"
STORAGE="${STORAGE_DIR:-./storage}"
[[ "$STORAGE" = /* ]] || STORAGE="$APP_DIR/$STORAGE"

mkdir -p "$BACKUP_DIR"
tmp="$BACKUP_DIR/.wfos-$STAMP.dump.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --no-owner "$DATABASE_URL" > "$tmp"
pg_restore --list "$tmp" > /dev/null # fails on a truncated or corrupt dump
mv "$tmp" "$BACKUP_DIR/wfos-$STAMP.dump"

# uploads only: agent-home, sandbox and the embedding model cache are rebuilt automatically
if [[ -d "$STORAGE/uploads" ]]; then
  tar -czf "$BACKUP_DIR/wfos-$STAMP-uploads.tar.gz" -C "$STORAGE" uploads
fi
cp "$APP_DIR/.env" "$BACKUP_DIR/wfos-$STAMP.env"

find "$BACKUP_DIR" -maxdepth 1 -name 'wfos-*' -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $BACKUP_DIR/wfos-$STAMP.dump ($(du -h "$BACKUP_DIR/wfos-$STAMP.dump" | cut -f1))"
