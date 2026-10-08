#!/usr/bin/env bash
# Backup for a native (PM2) install: Postgres dump + uploaded files + git mirrors + .env, with a checksum manifest.
#
# The .env copy matters: credentials in the database are encrypted with ENCRYPTION_KEY,
# so a dump restored without that key cannot decrypt SMTP passwords, repository tokens or Claude credentials.
#
#   deploy/backup.sh                       # writes to $BACKUP_DIR (default /root/backups/workforce-os)
#   KEEP_DAYS=30 deploy/backup.sh
#   cron: 30 2 * * * /path/to/workforce-os/deploy/backup.sh >> /var/log/workforce-os-backup.log 2>&1
#
# Restore: deploy/restore.sh (see docs/DEPLOY.md → Backups). Tested by deploy/test/backup-restore.sh.
# Not included: task workspaces under /var/lib/private/wfos (temporary by design; deliverables are in the database)
# and the embedding model cache (downloaded again).
set -euo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/workforce-os}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${DATABASE_URL:?DATABASE_URL missing in $ENV_FILE}"
STORAGE="${STORAGE_DIR:-./storage}"
[[ "$STORAGE" = /* ]] || STORAGE="$APP_DIR/$STORAGE"

mkdir -p "$BACKUP_DIR"
base="$BACKUP_DIR/wfos-$STAMP"
tmp="$base.dump.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --no-owner "$DATABASE_URL" > "$tmp"
pg_restore --list "$tmp" > /dev/null # fails on a truncated or corrupt dump
mv "$tmp" "$base.dump"

# uploads (documents, attachments) and the bare git mirrors (delivered agent branches)
for d in uploads repos; do
  if [[ -d "$STORAGE/$d" ]]; then tar -czf "$base-$d.tar.gz" -C "$STORAGE" "$d"; fi
done
cp "$ENV_FILE" "$base.env"

commit="$(git -C "$APP_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
{
  echo "created=$(date -Is)"
  echo "commit=$commit"
  echo "migrations=$(pg_restore --list "$base.dump" | grep -c 'TABLE DATA drizzle __drizzle_migrations' || true)"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$base").dump" "$(basename "$base")".env $(ls "$(basename "$base")"-*.tar.gz 2>/dev/null))
} > "$base.manifest"

find "$BACKUP_DIR" -maxdepth 1 -name 'wfos-*' -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $base.dump ($(du -h "$base.dump" | cut -f1)), manifest $base.manifest"
