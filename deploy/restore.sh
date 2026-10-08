#!/usr/bin/env bash
# Restore a Workforce OS backup made by deploy/backup.sh.
#
#   deploy/restore.sh --backup /root/backups/workforce-os/wfos-20261008-023000 \
#                     --target-url postgres://workforce:…@127.0.0.1:5432/workforce_os \
#                     [--storage /root/apps/workforce-os/storage] [--env-out /root/apps/workforce-os/.env] [--yes]
#
# Safe by default: checks the manifest checksums, refuses a target database that already has tables, refuses to
# overwrite existing uploads/repos or an existing .env, and asks before starting unless --yes.
# The target database must exist with the pgvector extension created by a superuser:
#   sudo -u postgres psql -c "CREATE DATABASE workforce_os OWNER workforce" -c "\c workforce_os" -c "CREATE EXTENSION vector"
# Stop wfos-web and wfos-worker before restoring into the live database's place.
set -euo pipefail
umask 077

BACKUP="" TARGET="" STORAGE="" ENV_OUT="" YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="${2%.dump}"; shift 2 ;;
    --target-url) TARGET="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --env-out) ENV_OUT="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$BACKUP" && -n "$TARGET" ]] || { sed -n '2,12p' "$0"; exit 2; }
[[ -f "$BACKUP.dump" ]] || { echo "no dump at $BACKUP.dump" >&2; exit 1; }

dir="$(dirname "$BACKUP")"
name="$(basename "$BACKUP")"
if [[ -f "$BACKUP.manifest" ]]; then
  (cd "$dir" && grep -E '^[0-9a-f]{64}  ' "$name.manifest" | sha256sum --check --quiet) || { echo "checksum mismatch: backup is damaged" >&2; exit 1; }
  echo "manifest ok ($(grep '^commit=' "$BACKUP.manifest"))"
else
  echo "warning: no manifest (backup made by an older backup.sh); checking the dump only" >&2
fi
pg_restore --list "$BACKUP.dump" > /dev/null

tables="$(psql "$TARGET" -Atqc "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")"
[[ "$tables" = 0 ]] || { echo "target database already has $tables tables; restore only into an empty database" >&2; exit 1; }
psql "$TARGET" -Atqc "select 1 from pg_extension where extname='vector'" | grep -q 1 \
  || { echo "pgvector is missing in the target database; a superuser must run CREATE EXTENSION vector there" >&2; exit 1; }

for d in uploads repos; do
  if [[ -f "$BACKUP-$d.tar.gz" ]]; then
    [[ -n "$STORAGE" ]] || { echo "--storage is required to restore $d" >&2; exit 1; }
    [[ ! -e "$STORAGE/$d" ]] || { echo "$STORAGE/$d already exists; move it away first" >&2; exit 1; }
  fi
done
[[ -z "$ENV_OUT" || ! -e "$ENV_OUT" ]] || { echo "$ENV_OUT already exists; refusing to overwrite" >&2; exit 1; }

if [[ "$YES" != 1 ]]; then
  read -r -p "Restore $name into $(sed -E 's#//[^@]*@#//***@#' <<< "$TARGET")? [y/N] " a
  [[ "$a" = y || "$a" = Y ]] || exit 1
fi

# --no-comments: COMMENT ON EXTENSION needs the extension owner; everything else must restore without errors
pg_restore --no-owner --no-privileges --no-comments --exit-on-error -d "$TARGET" "$BACKUP.dump"
for d in uploads repos; do
  if [[ -f "$BACKUP-$d.tar.gz" ]]; then mkdir -p "$STORAGE" && tar -xzf "$BACKUP-$d.tar.gz" -C "$STORAGE"; fi
done
[[ -z "$ENV_OUT" ]] || cp "$BACKUP.env" "$ENV_OUT"

echo "restored: $(psql "$TARGET" -Atqc "select count(*) from drizzle.__drizzle_migrations") migrations, $(psql "$TARGET" -Atqc "select count(*) from workspaces") workspaces, $(psql "$TARGET" -Atqc "select count(*) from users") users"
echo "next: make sure .env has the ENCRYPTION_KEY of this backup, run pnpm db:migrate (newer code), then start wfos-web and wfos-worker"
