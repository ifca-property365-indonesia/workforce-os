#!/usr/bin/env bash
# Proves backup.sh → restore.sh round-trips: schema, rows (including pgvector values), uploads, git mirrors, .env.
# Uses only throwaway databases it creates from the test template (TEST_DATABASE_ADMIN_URL in .env) and drops them.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
: "${TEST_DATABASE_ADMIN_URL:?set TEST_DATABASE_ADMIN_URL (see README → Tests)}"
TEMPLATE="${TEST_DATABASE_TEMPLATE:-workforce_os_test_template}"

suffix="$(date +%s)_$$"
SRC="wfos_br_src_$suffix" DST="wfos_br_dst_$suffix" BAD="wfos_br_bad_$suffix"
url() { sed -E "s#/[^/?]+(\?|$)#/$1\1#" <<< "$TEST_DATABASE_ADMIN_URL"; }
admin() { psql "$TEST_DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -Atqc "$1"; }
WORK="$(mktemp -d)"
cleanup() {
  for db in "$SRC" "$DST" "$BAD"; do admin "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

for db in "$SRC" "$DST" "$BAD"; do admin "CREATE DATABASE \"$db\" TEMPLATE \"$TEMPLATE\""; done

# source: the real schema plus some data
(cd "$ROOT" && DATABASE_URL="$(url "$SRC")" WFOS_ENV=test pnpm --silent --filter @wfos/db migrate > /dev/null)
psql "$(url "$SRC")" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO workspaces (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Backup WS', 'backup-ws');
INSERT INTO users (email, name, password_hash) VALUES ('backup@test.local', 'B', 'x');
INSERT INTO employees (id, workspace_id, name, role, model) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Dewi', 'Developer', 'm');
INSERT INTO memories (workspace_id, employee_id, content, embedding)
  SELECT '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'remember this', array_fill(0.25::real, ARRAY[384])::vector;
SQL
mkdir -p "$WORK/storage/uploads/ws1" "$WORK/storage/repos/r1.git"
echo "hello upload" > "$WORK/storage/uploads/ws1/doc.txt"
echo "ref: refs/heads/main" > "$WORK/storage/repos/r1.git/HEAD"
cat > "$WORK/app.env" <<ENV
DATABASE_URL=$(url "$SRC")
STORAGE_DIR=$WORK/storage
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
ENV

ENV_FILE="$WORK/app.env" BACKUP_DIR="$WORK/backups" "$ROOT/deploy/backup.sh" > /dev/null
B="$(ls "$WORK"/backups/wfos-*.dump | head -1)"; B="${B%.dump}"
[[ -f "$B.manifest" && -f "$B-uploads.tar.gz" && -f "$B-repos.tar.gz" && -f "$B.env" ]] || fail "backup files missing"
pass "backup wrote dump, uploads, repos, env and manifest"

# guard rails
if "$ROOT/deploy/restore.sh" --backup "$B" --target-url "$(url "$SRC")" --yes > /dev/null 2>&1; then fail "restored into a non-empty database"; fi
pass "refuses a target database that already has tables"
cp "$B.dump" "$WORK/orig.dump"; printf 'x' >> "$B.dump"
if "$ROOT/deploy/restore.sh" --backup "$B" --target-url "$(url "$BAD")" --yes > /dev/null 2>&1; then fail "restored a damaged backup"; fi
cp "$WORK/orig.dump" "$B.dump"
pass "refuses a backup whose checksum does not match"

"$ROOT/deploy/restore.sh" --backup "$B" --target-url "$(url "$DST")" --storage "$WORK/restored" --env-out "$WORK/restored.env" --yes > /dev/null
pass "restore completed without errors (--exit-on-error)"

# same schema, same data
schema() { pg_dump --schema-only --no-owner --no-privileges --no-comments "$1" | grep -vE '^(--|SET |SELECT pg_catalog|\\(un)?restrict)' | sed '/^$/d'; }
diff <(schema "$(url "$SRC")") <(schema "$(url "$DST")") > /dev/null || fail "schema differs after restore"
pass "schema identical"
for t in workspaces users employees memories drizzle.__drizzle_migrations; do
  a="$(psql "$(url "$SRC")" -Atqc "select md5(string_agg(x::text, ',' order by x::text)) from $t x")"
  b="$(psql "$(url "$DST")" -Atqc "select md5(string_agg(x::text, ',' order by x::text)) from $t x")"
  [[ "$a" = "$b" ]] || fail "rows of $t differ"
done
[[ "$(psql "$(url "$DST")" -Atqc "select embedding <-> array_fill(0.25::real, ARRAY[384])::vector from memories")" = 0 ]] || fail "vector value changed"
pass "rows identical (workspaces, users, employees, memories with vectors, migrations)"
diff -r "$WORK/storage/uploads" "$WORK/restored/uploads" > /dev/null && diff -r "$WORK/storage/repos" "$WORK/restored/repos" > /dev/null || fail "files differ"
cmp -s "$WORK/app.env" "$WORK/restored.env" || fail ".env differs"
pass "uploads, git mirrors and .env restored byte for byte"
if "$ROOT/deploy/restore.sh" --backup "$B" --target-url "$(url "$BAD")" --storage "$WORK/restored" --yes > /dev/null 2>&1; then fail "overwrote existing uploads"; fi
pass "refuses to overwrite existing uploads"
echo "backup/restore: all checks passed"
