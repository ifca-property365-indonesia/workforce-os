#!/usr/bin/env bash
# Exercises deploy/app-server/{wfos-app-helper,prepare.sh} in their dry-run modes only. The helper gets a temporary
# config, a temporary APPS_ROOT and a temporary prefix for its /etc, /var and /home paths (dry-run only overrides), so
# every command's happy path, every bad argument (exit 2, nothing to run), the guards (exit 3), the symlink and
# archive checks and prepare.sh's plan can be checked. Nothing is installed, run as root, or written outside the
# temp dir.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$HERE/wfos-app-helper"
PREPARE="$HERE/prepare.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0

fail() {
  echo "FAIL: $*" >&2
  [[ -f "$WORK/out" ]] && sed 's/^/    /' "$WORK/out" >&2
  exit 1
}
pass() {
  PASS=$((PASS + 1))
  echo "ok - $*"
}

ROOT="$WORK/srv/wfos-apps"
PFX="$WORK/sys"
mkdir -p "$ROOT" "$PFX/home/wfos-apps/incoming" "$PFX/etc/nginx/sites-enabled" "$PFX/etc/nginx/conf.d" \
  "$PFX/etc/systemd/system" "$PFX/var/lib/wfos-apps" "$PFX/etc/postgresql/18/apps" "$PFX/etc/letsencrypt/live"
cat > "$WORK/conf" << EOF
# test config
USER=wfos-apps
BASE_DOMAIN=preview.example.com
PG_PORT=5433
PG_VERSION=18
APPS_ROOT=$ROOT
PORT_MIN=4100
PORT_MAX=4499
EOF
SHA=0123456789abcdef0123456789abcdef01234567
SHA2=89abcdef0123456789abcdef0123456789abcdef
SECRET="s3cr3t-VALUE-never-printed"
BCRYPT='preview:$2y$10$abcdefghijklmnopqrstuuK0V2Hn1F7qz1Y5JjKqk7d0bW8yX9Zc.'

# helper ARGS... (stdin from /dev/null) / helper_in STDIN ARGS...: dry-run with the temp config and prefix; output in
# $WORK/out, exit code in $CODE. DISK, MEM and SD override free disk MB, MemTotal MB and the systemd version.
helper_in() {
  local input="$1"
  shift
  set +e
  printf '%s' "$input" | WFOS_HELPER_DRY_RUN=1 WFOS_HELPER_CONF="${CONF_FILE:-$WORK/conf}" WFOS_HELPER_TEST_PREFIX="$PFX" \
    WFOS_HELPER_TEST_DISK_FREE_MB="${DISK:-50000}" WFOS_HELPER_TEST_MEM_TOTAL_MB="${MEM:-8000}" \
    WFOS_HELPER_TEST_SYSTEMD="${SD:-259}" "$HELPER" "$@" > "$WORK/out" 2>&1
  CODE=$?
  set -e
}
helper() { helper_in "" "$@"; }
# helper_file FILE ARGS...: stdin from a file (for bytes a bash string cannot hold, like NUL)
helper_file() {
  local file="$1"
  shift
  set +e
  WFOS_HELPER_DRY_RUN=1 WFOS_HELPER_CONF="${CONF_FILE:-$WORK/conf}" WFOS_HELPER_TEST_PREFIX="$PFX" \
    WFOS_HELPER_TEST_DISK_FREE_MB="${DISK:-50000}" WFOS_HELPER_TEST_MEM_TOTAL_MB="${MEM:-8000}" \
    WFOS_HELPER_TEST_SYSTEMD="${SD:-259}" "$HELPER" "$@" < "$file" > "$WORK/out" 2>&1
  CODE=$?
  set -e
}
has() { grep -qF -- "$1" "$WORK/out" || fail "$2: expected output to contain: $1"; }
hasnt() { ! grep -qF -- "$1" "$WORK/out" || fail "$2: expected output not to contain: $1"; }
code() { [[ "$CODE" == "$1" ]] || fail "$2: expected exit $1, got $CODE"; }
last_line() { [[ "$(tail -1 "$WORK/out")" == "$1" ]] || fail "$2: expected the last line to be: $1"; }
# a rejected call: exit 2, one-line error, nothing it would run or write
rejected() {
  code 2 "$1"
  hasnt "[dry-run]" "$1"
  [[ "$(wc -l < "$WORK/out")" -le 1 ]] || fail "$1: expected a one-line error"
}
# a guard: exit 3 with the reason code on stderr
guarded() {
  code 3 "$2"
  has "wfos-app-helper: $1:" "$2"
}
# hasline LINE MSG: the output has exactly this line (not just a line that starts with it)
hasline() { grep -qxF -- "$1" "$WORK/out" || fail "$2: expected the line: $1"; }
hasntline() { ! grep -qxF -- "$1" "$WORK/out" || fail "$2: expected no line: $1"; }
# written PATH: what the last "[dry-run] write PATH" of the output would put into PATH
written() {
  awk -v b="[dry-run] write $1 (" -v e="[dry-run] end $1" '
    index($0, b) == 1 { buf = ""; on = 1; next }
    on && $0 == e { on = 0; last = buf; next }
    on { sub(/^  \| ?/, ""); buf = buf $0 "\n" }
    END { printf "%s", last }' "$WORK/out"
}
# site_blocks PATH: the last site written to PATH, one file per server block: $WORK/blk.1, $WORK/blk.2, …
site_blocks() {
  rm -f "$WORK"/blk.*
  written "$1" | awk -v d="$WORK/blk" '/^server \{/ { n++ } n { print > (d "." n) }'
}
# app skeleton as app-init leaves it (a fresh one per test that needs it)
fresh_app() {
  rm -rf "${ROOT:?}/$1"
  mkdir -p "$ROOT/$1/releases" "$ROOT/$1/data" "$ROOT/$1/cache" "$ROOT/$1/backups"
}
# tarball NAME TREE-DIR [tar options...]: the upload for shop/$SHA, built from a tree in the temp dir
upload() {
  local dir="$1"
  shift
  tar -czf "$PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz" -C "$dir" "$@"
}

# --- version / info --------------------------------------------------------
helper version
code 0 "version"
[[ "$(cat "$WORK/out")" == 3 ]] || fail "version prints 3"
pass "version prints 3"

helper info
code 0 "info"
json="$(tail -1 "$WORK/out")"
if command -v node > /dev/null; then
  node -e 'const j = JSON.parse(process.argv[1]); const ok = j.helperVersion === 3 && j.baseDomain === "preview.example.com" && typeof j.nginx === "boolean" && typeof j.certbot === "boolean" && typeof j.diskFreeMb === "number" && typeof j.memTotalMb === "number" && typeof j.memAvailableMb === "number" && typeof j.os === "string" && typeof j.node === "string" && typeof j.pnpm === "string" && ("postgresPort" in j) && typeof j.systemd === "number" && j.firewall === false && typeof j.appsRoot === "string"; if (!ok) process.exit(1)' "$json" || fail "info JSON shape: $json"
elif command -v jq > /dev/null; then
  jq -e '.helperVersion == 3 and .baseDomain == "preview.example.com" and (.nginx | type == "boolean") and (.systemd | type == "number") and .firewall == false' <<< "$json" > /dev/null || fail "info JSON shape: $json"
fi
pass "info prints one JSON line (helperVersion 3, the A1 fields, systemd, firewall)"

# --- bad arguments: exit 2, one line, nothing to run ------------------------
fresh_app shop
helper frobnicate shop
rejected "unknown command"
helper
rejected "no command"
helper version extra
rejected "version with an argument"
helper info extra
rejected "info with an argument"
helper stop-all extra
rejected "stop-all with an argument"
helper unit-remove shop
rejected "the A1 draft's unit-remove is gone"
pass "unknown commands and wrong argument counts exit 2"

LONG36="$(printf 'a%.0s' {1..36})"
for s in Shop a -ab ab- "a--b" "shop--live" "shop-live-" www api preview status "$LONG36" "a b" "a;b" "a/b" "../x" "" 1ab "shop_1" "Shop-live" "shop.live"; do
  for c in app-init unit-status release-prune unpublish; do
    helper "$c" "$s"
    rejected "$c with instance name ${s@Q}"
  done
done
pass "invalid and reserved instance names exit 2 (2 to 35 characters, no --)"

for args in \
  "release-unpack shop 0123" "release-unpack shop ${SHA^^}" "release-unpack shop ${SHA}0" "release-unpack shop" \
  "release-activate shop xyz" "build-run shop $SHA test 900 1536" "build-run shop $SHA install 9 1536" \
  "build-run shop $SHA install 3601 1536" "build-run shop $SHA install 900 255" "build-run shop $SHA install 900 4097" \
  "build-run shop $SHA install 900 4001" "build-run shop $SHA install 900" "build-run shop $SHA install 0900 1536" \
  "unit-install shop 4099 512" "unit-install shop 4500 512" "unit-install shop abc 512" "unit-install shop 4100 512 --db" \
  "unit-install shop 4100 100" "health shop 4100 api" "health shop 4100 /a?b" "health shop 80 /" \
  "publish shop 4100 --noauth" "publish shop 4100 --auth extra" "db-create shop --force" "db-dump shop a/b" \
  "db-dump shop $(printf 'x%.0s' {1..65})" "db-restore shop a.b" "app-remove shop --drop" "unit-status shop extra"; do
  # shellcheck disable=SC2086 # word splitting builds the argument list on purpose
  helper_in "pnpm build" $args
  rejected "$args"
done
helper db-dump shop ""
rejected "db-dump with an empty name"
pass "bad sha, step, timeout, memory (incl. over half of MemTotal), port, path, flag and name exit 2"

mkdir -p "$ROOT/shop/releases/$SHA"
MEM=16000 helper_in "pnpm build" build-run shop "$SHA" install 900 4096
code 0 "4096 MB is fine on a 16 GB server"
pass "memory cap follows MemTotal"

for input in "" $'pnpm\nbuild' $'pnpm\tbuild' "$(printf 'x%.0s' {1..501})" $'a\n\n'; do
  helper_in "$input" build-run shop "$SHA" build 1200 1536
  rejected "build-run command ${input:0:20}"
  helper_in "$input" unit-install shop 4100 512
  rejected "unit-install start ${input:0:20}"
done
printf 'pnpm \000build\n' > "$WORK/nul.in"
helper_file "$WORK/nul.in" build-run shop "$SHA" build 1200 1536
rejected "build-run command with NUL"
printf 'A=ok\nB=x\000%s\n' "$SECRET" > "$WORK/nul.in"
helper_file "$WORK/nul.in" env-install shop
rejected "env-install value with NUL"
hasnt "$SECRET" "env-install error never echoes a value"
for pw in "" short "0123456789ABCDEF0123456789ABCDEF" $'0123456789abcdef0123456789abcdef\nx' "0123456789abcdef0123456789abcdeg"; do
  helper_in "$pw" db-create shop
  rejected "db-create password ${pw:0:10}"
done
for line in "" "preview:secret" 'preview:$apr1$abcdefgh$abcdefghijklmnopqrstuv' "${BCRYPT/preview/admin}" "$BCRYPT"$'\n'"$BCRYPT" "${BCRYPT}x"; do
  helper_in "$line" publish shop 4100 --auth
  rejected "publish --auth line ${line:0:12}"
done
pass "stdin payloads (commands, passwords, htpasswd lines) are validated before anything runs"

envs_bad=(
  "lower=1"
  "1A=1"
  "A B=1"
  "NOEQUALS"
  "A=$SECRET"$'\n'"A=again"
  "A=$SECRET"$'\n'"continues on the next line"
  "A=$SECRET"$'\r'
  "A=$(printf 'v%.0s' {1..4001})"
  "$(for i in $(seq 1 81); do echo "K$i=v"; done)"
  "HOME=/tmp" "PATH=/tmp" "LD_PRELOAD=/x.so" "LD_LIBRARY_PATH=/x" "COREPACK_HOME=/x" "COREPACK_ENABLE_NETWORK=1"
  "NPM_CONFIG_STORE_DIR=/x" "XDG_CACHE_HOME=/x" "HOST=0.0.0.0" "HOST=127.0.0.1 "
)
for e in "${envs_bad[@]}"; do
  helper_in "$e" env-install shop
  rejected "env-install ${e:0:20}"
  hasnt "$SECRET" "env-install error never echoes a value"
done
pass "env-install refuses bad names, CR/NUL, a value with a newline, duplicates, long values, > 80 lines (values never echoed)"
pass "env-install refuses HOME, PATH, LD_*, COREPACK_*, NPM_CONFIG_STORE_DIR, XDG_CACHE_HOME and a HOST other than 127.0.0.1"

# --- config validation --------------------------------------------------------
bad_conf() {
  sed "$1" "$WORK/conf" > "$WORK/bad.conf"
  CONF_FILE="$WORK/bad.conf" helper info
  code 1 "config: $2"
  hasnt "helperVersion" "config: $2"
}
bad_conf 's/^USER=.*/USER=root/' "USER=root"
bad_conf 's/^USER=.*/USER=$(touch pwned)/' "USER with a command"
bad_conf 's|^APPS_ROOT=.*|APPS_ROOT=/home/x/../root|' "APPS_ROOT with .."
bad_conf 's|^APPS_ROOT=.*|APPS_ROOT=relative/apps|' "relative APPS_ROOT"
bad_conf 's/^BASE_DOMAIN=.*/BASE_DOMAIN=example.com;evil/' "BASE_DOMAIN with ;"
bad_conf 's/^PORT_MIN=.*/PORT_MIN=5000/' "PORT_MIN > PORT_MAX"
bad_conf 's/^PG_PORT=.*/PG_PORT=80/' "PG_PORT 80"
bad_conf 's/^PG_VERSION=.*/PG_VERSION=18;x/' "PG_VERSION with ;"
bad_conf 's/^USER=.*/USER wfos-apps/' "a line without ="
[[ ! -e pwned && ! -e "$WORK/pwned" ]] || fail "config values must never be executed"
CONF_FILE="$WORK/missing.conf" helper info
code 1 "missing config"
sed '/^PG_VERSION=/d' "$WORK/conf" > "$WORK/v1.conf"
CONF_FILE="$WORK/v1.conf" helper_in 0123456789abcdef0123456789abcdef db-create shop
code 1 "db-create with an A1 config"
has "re-run prepare.sh" "db-create with an A1 config"
pass "a bad or missing config stops the helper; an A1 config (no PG_VERSION) asks to re-run prepare.sh"

# --- app-init -----------------------------------------------------------------
rm -rf "${ROOT:?}/shop"
helper app-init shop
code 0 "app-init"
for line in \
  "[dry-run] flock /run/wfos-app-helper.lock" \
  "[dry-run] groupadd --system --gid 460" \
  "[dry-run] useradd --system --uid 460" \
  "--gid wa-shop --groups wfos-app-run --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment Workforce\ OS\ app\ shop wa-shop" \
  "[dry-run] install -d -m 0755 -o root -g root $ROOT/shop $ROOT/shop/releases" \
  "[dry-run] install -d -m 0700 -o wa-shop -g wa-shop $ROOT/shop/data $ROOT/shop/cache $ROOT/shop/next-cache" \
  "[dry-run] install -d -m 0700 -o root -g root $ROOT/shop/backups"; do
  has "$line" "app-init"
done
long="abcdefghijklmnopqrstuvwxyz1234"
helper app-init "$long"
code 0 "app-init with a 30-character slug"
user="$(sed -nE 's/.*groupadd --system --gid [0-9]+ (wa-[a-z0-9-]+).*/\1/p' "$WORK/out")"
[[ -n "$user" && ${#user} -le 31 && "$user" == wa-abcdefghijklmnopqrs-* ]] || fail "long slug user name: ${user@Q}"
pass "app-init: user wa-<slug> (wfos-app-run only, no login, no home), root-owned structure, app-owned data/cache (≤ 31 chars)"

# accounts come from their own id range with a marker; a same-named account that is not ours is never used or removed
printf 'root:x:0:0:root:/root:/bin/bash\nwa-shop:x:1005:1005:Someone else:/home/x:/bin/bash\nwa-blog:x:460003:460003:Workforce OS app blog:/nonexistent:/usr/sbin/nologin\nwa-x1:x:460000:460000:Workforce OS app x1:/nonexistent:/usr/sbin/nologin\n' > "$WORK/acct.passwd"
printf 'root:x:0:\nwa-shop:x:1005:\nwa-blog:x:460003:\nwa-x1:x:460000:\nwa-new:x:460001:\n' > "$WORK/acct.group"
WFOS_HELPER_TEST_ACCOUNTS="$WORK/acct" helper app-init shop
code 1 "app-init over a foreign group wa-shop"
has "was not made by wfos-app-helper" "app-init over a foreign group"
hasnt "install -d" "app-init over a foreign account"
WFOS_HELPER_TEST_ACCOUNTS="$WORK/acct" helper app-remove shop
code 1 "app-remove of a foreign user"
hasnt "userdel" "app-remove of a foreign user"
hasnt "rm -rf" "app-remove of a foreign user"
rm -rf "${ROOT:?}/blog"
WFOS_HELPER_TEST_ACCOUNTS="$WORK/acct" helper app-init blog
code 0 "app-init of our own existing account"
has "user wa-blog exists" "app-init reuses its own account"
hasnt "useradd" "app-init reuses its own account"
WFOS_HELPER_TEST_ACCOUNTS="$WORK/acct" helper app-init fresh
code 0 "app-init picks a free id"
has "[dry-run] groupadd --system --gid 460002 wa-fresh" "app-init: the lowest id that is neither a uid nor a gid"
mkdir -p "$WORK/full/srv"
for a in one two; do mkdir -p "$WORK/full/srv/$a"; done
sed "s|^APPS_ROOT=.*|APPS_ROOT=$WORK/full/srv|" "$WORK/conf" > "$WORK/full.conf"
echo "MAX_APPS=2" >> "$WORK/full.conf"
CONF_FILE="$WORK/full.conf" helper app-init three
guarded server_full "app-init over MAX_APPS"
hasnt "useradd" "app-init over MAX_APPS"
CONF_FILE="$WORK/full.conf" helper app-init one
code 0 "app-init of an existing app over MAX_APPS"
rm -rf "${ROOT:?}/blog" "${ROOT:?}/fresh"
pass "app accounts: own id range + GECOS marker, foreign accounts never used or removed, at most MAX_APPS apps"

# --- symlinks are never followed as root ----------------------------------------
mkdir -p "$WORK/outside"
ln -s "$WORK/outside" "$ROOT/evil"
helper app-init evil
code 1 "app-init over a symlinked app folder"
has "is a symlink" "app-init over a symlinked app folder"
hasnt "install -d" "app-init over a symlinked app folder"
fresh_app shop
rm -rf "$ROOT/shop/data"
ln -s "$WORK/outside" "$ROOT/shop/data"
helper app-init shop
code 1 "app-init over a symlinked data/"
hasnt "install -d" "app-init over a symlinked data/"
fresh_app shop
ln -s "$WORK/outside" "$ROOT/shop/releases/$SHA"
helper release-activate shop "$SHA"
code 1 "release-activate of a symlinked release"
hasnt "ln -sfn" "release-activate of a symlinked release"
helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
code 1 "build-run in a symlinked release"
hasnt "systemd-run" "build-run in a symlinked release"
mkdir -p "$WORK/realroot"
ln -s "$WORK/realroot" "$WORK/linkroot"
sed "s|^APPS_ROOT=.*|APPS_ROOT=$WORK/linkroot|" "$WORK/conf" > "$WORK/link.conf"
CONF_FILE="$WORK/link.conf" helper app-init shop
code 1 "APPS_ROOT through a symlink"
pass "a planted symlink (app folder, data/, release, APPS_ROOT) is refused, never followed"

# --- release-unpack -------------------------------------------------------------
fresh_app shop
mkdir -p "$WORK/tree/app/src"
echo '{"type":"nextjs"}' > "$WORK/tree/app/wfos-app.json"
echo 'x' > "$WORK/tree/app/src/index.js"
ln -sfn src/index.js "$WORK/tree/app/main.js"
upload "$WORK/tree/app" .
helper release-unpack shop "$SHA"
code 0 "release-unpack"
has "[dry-run] install -d -m 0750 -o wa-shop -g wa-shop $ROOT/shop/releases/$SHA" "release-unpack"
has "runuser -u wfos-apps -- cat -- $PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz | runuser -u wa-shop -g wfos-app-run -- sh -c 'cat > $ROOT/shop/cache/.upload.XXXXXX/upload.tar.gz'" "release-unpack copies the upload once"
has "systemd-run --scope --slice=wfos-apps.slice -p MemoryMax=1G -p TasksMax=64 -- timeout 900 runuser -u wa-shop -g wfos-app-run -- tar -xzf <that copy> -C $ROOT/shop/releases/$SHA --no-same-owner --no-same-permissions" "release-unpack unpacks that copy, limited"
has "[dry-run] flock /run/wfos-app-helper.build.lock" "release-unpack takes the build lock"
has "[dry-run] unlock /run/wfos-app-helper.lock" "release-unpack unpacks without the global lock"
has "[dry-run] runuser -u wfos-apps -- rm -f -- $PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz" "release-unpack"
hasnt "rm -rf" "release-unpack into a fresh dir"
pass "release-unpack: the SSH user reads the upload, the app user unpacks it (no owner/permissions kept), the upload is deleted"

mkdir -p "$ROOT/shop/releases/$SHA"
helper release-unpack shop "$SHA"
code 0 "release-unpack over a stale copy"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop/releases/$SHA" "release-unpack over a stale copy"
ln -sfn "releases/$SHA" "$ROOT/shop/current"
helper release-unpack shop "$SHA"
guarded release_active "release-unpack of the running release"
hasnt "rm -rf" "release-unpack of the running release"
rm -f "$ROOT/shop/current"
DISK=1500 helper release-unpack shop "$SHA"
guarded disk_low "release-unpack with 1500 MB free"
hasnt "install -d" "release-unpack with low disk"
pass "release-unpack replaces a stale non-current copy, never the running one, and refuses when disk is low (exit 3)"

bad_archive() {
  helper release-unpack shop "$SHA"
  guarded bad_archive "$1"
  hasnt "install -d" "$1"
  hasnt "tar -xzf" "$1"
}
mkdir -p "$WORK/t1/sub" && echo x > "$WORK/t1/evil"
(cd "$WORK/t1/sub" && tar -czPf "$PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz" ../evil)
bad_archive "a ../ member"
tar -czPf "$PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz" "$WORK/t1/evil" 2> /dev/null
bad_archive "an absolute member"
mkdir -p "$WORK/t2" && ln -sfn /etc "$WORK/t2/etc"
upload "$WORK/t2" .
bad_archive "a symlink to /etc"
mkdir -p "$WORK/t3/a" && ln -sfn ../../x "$WORK/t3/a/up"
upload "$WORK/t3" .
bad_archive "a symlink with .."
mkdir -p "$WORK/t4" && mkfifo "$WORK/t4/pipe"
upload "$WORK/t4" .
bad_archive "a fifo"
echo "not gzip" > "$PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz"
bad_archive "not a tar.gz"
mkdir -p "$WORK/t5"
printf 'x' > "$WORK/t5/a\$(id)"
upload "$WORK/t5" .
helper release-unpack shop "$SHA"
code 0 "a strange but harmless name"
mkdir -p "$WORK/t6" && ln -sfn '/etc/$(id)' "$WORK/t6/l"
upload "$WORK/t6" .
bad_archive "a symlink with a shell-ish target"
has "symlink ./l may point outside the release (/etc/\\\$\\(id\\))" "error names are printed with %q"
rm -f "$PFX/home/wfos-apps/incoming/shop-$SHA.tar.gz"
helper release-unpack shop "$SHA"
code 1 "release-unpack without an upload"
pass "archives with ../ or absolute members, escaping symlinks, special files or garbage are refused (exit 3 bad_archive)"

# --- env-install -----------------------------------------------------------------
helper_in "PORT=4100"$'\n'"HOST=127.0.0.1"$'\n'"DATABASE_URL=postgresql://app_shop:$SECRET@localhost/app_shop?host=/run/wfos-apps-pg"$'\n'"QUOTE=a\"b\$c\`d\\e"$'\n' env-install shop
code 0 "env-install"
has "[dry-run] write $PFX/etc/wfos-apps/env/shop.env (mode 0600, owner root:root)" "env-install"
has "(4 variables: PORT HOST DATABASE_URL QUOTE)" "env-install"
hasnt "$SECRET" "env-install never prints a value"
hasnt "127.0.0.1" "env-install never prints a value"
pass "env-install writes a 0600 root file atomically and never prints a value"

# --- build-run -------------------------------------------------------------------
fresh_app shop
mkdir -p "$ROOT/shop/releases/$SHA"
helper_in "pnpm install --frozen-lockfile" build-run shop "$SHA" install 900 1536
code 0 "build-run install"
for line in \
  "systemd-run --wait --pipe --collect --quiet --unit=wfos-build-shop.service" \
  "--uid=wa-shop --gid=wfos-app-run --expand-environment=no" \
  "-p TemporaryFileSystem=$ROOT:ro -p BindReadOnlyPaths=$ROOT/shop -p BindPaths=$ROOT/shop/data\ $ROOT/shop/cache -p BindPaths=$ROOT/shop/releases/$SHA" \
  "-p TemporaryFileSystem=$PFX/etc/wfos-apps:ro" \
  "-p TemporaryFileSystem=/run:ro -p BindReadOnlyPaths=-/run/systemd/resolve -p TemporaryFileSystem=/opt:ro -p BindReadOnlyPaths=/opt/wfos-apps/corepack" \
  "-p InaccessiblePaths=-/root\ -/home\ -/etc/letsencrypt\ -/etc/wfos-app-helper.conf\ -/etc/nginx\ -$PFX/var/lib/wfos-apps\ -/var/log\ -/var/lib/cloud\ -/var/www\ -/mnt\ -/media\ -/usr/local/sbin" \
  "-p SystemCallFilter=\\~io_uring_setup\ io_uring_enter\ io_uring_register\ userfaultfd" \
  "-p OOMScoreAdjust=500 -p LimitNOFILE=4096 -p LimitFSIZE=2G" \
  "--slice=wfos-apps.slice" \
  "-p Requires=wfos-apps-firewall.service -p After=wfos-apps-firewall.service" \
  "-p IPAddressDeny=127.0.0.0/8\ ::1/128\ 169.254.0.0/16\ fe80::/10\ 224.0.0.0/4\ ff00::/8\ 0.0.0.0/8\ 10.0.0.0/8\ 100.64.0.0/10\ 172.16.0.0/12\ 192.168.0.0/16\ fc00::/7" \
  "-p IPAddressAllow=127.0.0.53" \
  "[dry-run] flock /run/wfos-app-helper.build.lock" \
  "[dry-run] unlock /run/wfos-app-helper.lock" \
  "-p EnvironmentFile=$PFX/etc/wfos-apps/env/shop.env" \
  "COREPACK_HOME=/opt/wfos-apps/corepack" \
  "-p Environment=CI=1\ npm_config_store_dir=$ROOT/shop/cache/pnpm-store" \
  "NEXT_TELEMETRY_DISABLED=1" \
  "-p WorkingDirectory=$ROOT/shop/releases/$SHA -p RuntimeMaxSec=900 -p MemoryMax=1536M -p MemorySwapMax=0" \
  "-p ProtectProc=invisible -p ProcSubset=pid -p OOMScoreAdjust=500 -p LimitNOFILE=4096 -p LimitFSIZE=2G -p PrivatePIDs=yes" \
  "-p CapabilityBoundingSet= " "-p SystemCallFilter=@system-service" "-p RestrictAddressFamilies=AF_INET\ AF_INET6\ AF_UNIX" \
  "-p UMask=0077" "-p NoNewPrivileges=yes" "-p ProtectSystem=strict" "-p ProtectHome=yes" \
  "/usr/bin/env -u NODE_ENV /bin/sh -c pnpm\ install\ --frozen-lockfile"; do
  has "$line" "build-run install"
done
hasnt "DynamicUser" "build-run install"
hasnt "BindReadOnlyPaths=/run/wfos-apps-pg" "build-run install"
helper_in 'pnpm prisma migrate deploy' build-run shop "$SHA" migrate 300 1024
code 0 "build-run migrate"
has "-p BindReadOnlyPaths=/run/wfos-apps-pg" "build-run migrate"
hasnt "env -u NODE_ENV" "build-run migrate"
SD=256 helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
hasnt "PrivatePIDs" "build-run on systemd 256"
has "--expand-environment=no" "build-run on systemd 256"
SD=252 helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
hasnt "--expand-environment" "build-run on systemd 252"
DISK=100 helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
guarded disk_low "build-run with low disk"
hasnt "systemd-run" "build-run with low disk"
helper_in "pnpm build" build-run shop "$SHA2" build 1200 1536
guarded release_missing "build-run of a missing release"
WFOS_HELPER_TEST_FIREWALL=0 helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
guarded firewall_off "build-run without the app firewall"
hasnt "systemd-run" "build-run without the app firewall"
ln -sfn "releases/$SHA" "$ROOT/shop/current"
helper_in "pnpm build" build-run shop "$SHA" build 1200 1536
guarded release_active "build-run in the running release"
rm -f "$ROOT/shop/current"
pass "build-run: sandboxed transient unit as wa-<slug>/wfos-app-run, writable release+cache, pg socket only for migrate, disk guard"
pass "build-run: build lock, firewall required (exit 3 firewall_off), not in the running release, slice, IP filter, /run and /opt allowlisted"

# --- db-create / db-dump / db-restore ----------------------------------------------
PW=0123456789abcdef0123456789abcdef
printf 'local all postgres peer\n' > "$PFX/etc/postgresql/18/apps/pg_hba.conf"
helper_in "$PW" db-create shop
code 0 "db-create"
has "[dry-run] runuser -u postgres -- /usr/lib/postgresql/18/bin/psql -X -q -v ON_ERROR_STOP=1 -h /run/wfos-apps-pg -p 5433 -d postgres" "db-create"
has "create role app_shop (password only when it is new)" "db-create"
has "REVOKE CONNECT ON DATABASE app_shop, postgres, template1 FROM PUBLIC" "db-create"
has "  | local app_shop app_shop peer map=wfos_app_shop" "db-create"
has "  | local app_shop app_shop scram-sha-256" "db-create"
grep -A2 -F "  | local app_shop app_shop peer map=wfos_app_shop" "$WORK/out" | grep -qF "  | local app_shop app_shop scram-sha-256" || fail "db-create: the peer line comes before the scram line"
has "  | local all postgres peer" "db-create"
has "[dry-run] write $PFX/etc/postgresql/18/apps/pg_ident.conf" "db-create writes the peer map"
has "  | wfos_app_shop postgres app_shop" "db-create: postgres may log in as the app role (dump/restore)"
has "  | wfos_app_shop wa-shop app_shop" "db-create: the app's own user may log in as the app role"
has "CONNECTION LIMIT 10, statement_timeout and idle_in_transaction_session_timeout 60s" "db-create role limits"
hasnt "$PW" "db-create never prints the password"
printf 'local all postgres peer\nlocal app_shop app_shop peer map=wfos_app_shop\nlocal app_shop app_shop scram-sha-256\n' > "$PFX/etc/postgresql/18/apps/pg_hba.conf"
printf 'wfos_app_shop postgres app_shop\nwfos_app_shop wa-shop app_shop\n' > "$PFX/etc/postgresql/18/apps/pg_ident.conf"
helper_in "$PW" db-create shop --reset-password
code 0 "db-create --reset-password"
has "--reset-password: the password is set again" "db-create --reset-password"
has "pg_hba.conf: unchanged" "db-create twice"
has "pg_ident.conf: unchanged" "db-create twice"
hasnt "pg_reload_conf" "db-create twice reloads nothing"
helper_in "$PW" db-create my-shop
has "  | local app_my_shop app_my_shop scram-sha-256" "db-create with a dash"
pass "db-create: role/db app_<slug> over the socket, password kept unless --reset-password, REVOKE/GRANT CONNECT, pg_hba line"

fresh_app shop
for i in 1 2 3 4 5 6 7 8; do
  touch -d "2026-01-0$i" "$ROOT/shop/backups/b$i.dump"
done
helper db-dump shop rel-123
code 0 "db-dump"
has "runuser -u postgres -- /usr/lib/postgresql/18/bin/pg_dump -h /run/wfos-apps-pg -p 5433 -U app_shop -Fc -d app_shop > $ROOT/shop/backups/rel-123.dump" "db-dump as the app role"
has "[dry-run] rm -f -- $ROOT/shop/backups/b1.dump" "db-dump prunes the oldest"
hasnt "b2.dump" "db-dump keeps 7"
helper db-restore shop b5
code 0 "db-restore"
has "pg_restore -h /run/wfos-apps-pg -p 5433 -U app_shop -d app_shop --clean --if-exists --no-owner --no-privileges --single-transaction < $ROOT/shop/backups/b5.dump" "db-restore as the app role"
hasnt "--role" "db-restore never switches roles from a superuser session"
helper db-restore shop nope
code 1 "db-restore of a missing backup"
pass "db-dump / db-restore log in as the app role (peer map), never as a superuser; 7 backups kept"

# --- release-activate / release-prune ---------------------------------------------------
fresh_app shop
mkdir -p "$ROOT/shop/releases/$SHA" "$ROOT/shop/releases/$SHA2"
helper release-activate shop "$SHA"
code 0 "release-activate (first)"
has "[dry-run] ln -sfn releases/$SHA $ROOT/shop/.current.wfos-tmp" "release-activate"
has "[dry-run] mv -fT -- $ROOT/shop/.current.wfos-tmp $ROOT/shop/current" "release-activate"
last_line none "release-activate (first)"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop/next-cache" "release-activate empties the Next.js cache"
has "[dry-run] install -d -m 0700 -o wa-shop -g wa-shop $ROOT/shop/next-cache" "release-activate recreates the Next.js cache"
ln -sfn "releases/$SHA2" "$ROOT/shop/current"
helper release-activate shop "$SHA"
code 0 "release-activate (second)"
last_line "$SHA2" "release-activate prints the previous sha"
has "rm -rf --one-file-system -- $ROOT/shop/next-cache" "release-activate of a new version empties the Next.js cache"
ln -sfn "releases/$SHA" "$ROOT/shop/current"
helper release-activate shop "$SHA"
last_line "$SHA" "release-activate of the running version"
hasnt "next-cache" "release-activate of the same version keeps the Next.js cache"
rm -rf "$ROOT/shop/releases/$SHA"
helper release-activate shop "$SHA"
guarded release_missing "release-activate of a pruned release"
pass "release-activate swaps current atomically and prints the previous sha (or none); exit 3 release_missing"

fresh_app shop
i=0
for s in 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 \
  3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555; do
  i=$((i + 1))
  mkdir -p "$ROOT/shop/releases/$s"
  touch -d "2026-01-0$i" "$ROOT/shop/releases/$s"
done
ln -sfn releases/1111111111111111111111111111111111111111 "$ROOT/shop/current"
ln -s "$WORK/outside" "$ROOT/shop/releases/6666666666666666666666666666666666666666"
helper release-prune shop
code 0 "release-prune"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop/releases/2222222222222222222222222222222222222222" "release-prune"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop/releases/3333333333333333333333333333333333333333" "release-prune"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop/releases/6666666666666666666666666666666666666666" "release-prune removes a planted link itself"
hasnt "releases/1111111111111111111111111111111111111111" "release-prune keeps current"
hasnt "releases/5555555555555555555555555555555555555555" "release-prune keeps the newest"
hasnt "releases/4444444444444444444444444444444444444444" "release-prune keeps the newest"
[[ -d "$WORK/outside" ]] || fail "release-prune must not touch a link's target"
pass "release-prune keeps current + the 2 newest (3 in all) and removes planted links without following them"

# --- unit-install and unit actions -------------------------------------------------------
fresh_app shop
helper_in 'pnpm start -H 127.0.0.1 -p $PORT' unit-install shop 4100 512
code 0 "unit-install"
for line in \
  "[dry-run] write $PFX/etc/wfos-apps/start/shop.sh (mode 0644, owner root:root)" \
  '  | pnpm start -H 127.0.0.1 -p $PORT' \
  "[dry-run] write $PFX/etc/systemd/system/wfos-app-shop.service (mode 0644, owner root:root)" \
  "  | Requires=wfos-apps-firewall.service" \
  "  | Slice=wfos-apps.slice" "  | ExecStartPre=+/usr/sbin/nft list table inet wfos_apps" \
  "  | User=wa-shop" "  | Group=wfos-app-run" \
  "  | OOMScoreAdjust=500" "  | LimitNOFILE=4096" "  | LimitFSIZE=2G" \
  "  | SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register userfaultfd" \
  "  | TemporaryFileSystem=/run:ro" "  | BindReadOnlyPaths=-/run/systemd/resolve" \
  "  | TemporaryFileSystem=/opt:ro" "  | BindReadOnlyPaths=/opt/wfos-apps/corepack" \
  "  | WorkingDirectory=$ROOT/shop/current" \
  "  | ExecStart=/bin/sh $PFX/etc/wfos-apps/start/shop.sh" \
  "  | EnvironmentFile=$PFX/etc/wfos-apps/env/shop.env" \
  "  | Environment=HOST=127.0.0.1 PORT=4100 NODE_ENV=production" \
  "  | MemoryMax=512M" "  | MemorySwapMax=0" "  | CPUQuota=100%" "  | TasksMax=256" \
  "  | SocketBindAllow=tcp:4100" "  | SocketBindDeny=any" \
  "  | UMask=0077" "  | NoNewPrivileges=yes" "  | CapabilityBoundingSet=" "  | RestrictSUIDSGID=yes" "  | LockPersonality=yes" \
  "  | RestrictNamespaces=yes" "  | SystemCallArchitectures=native" "  | SystemCallFilter=@system-service" \
  "  | RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" "  | ProtectSystem=strict" "  | ProtectHome=yes" \
  "  | PrivateTmp=yes" "  | PrivateDevices=yes" "  | ProtectKernelTunables=yes" "  | ProtectKernelModules=yes" \
  "  | ProtectControlGroups=yes" "  | ProtectProc=invisible" "  | ProcSubset=pid" "  | PrivatePIDs=yes" \
  "  | TemporaryFileSystem=$ROOT:ro" "  | BindReadOnlyPaths=$ROOT/shop" "  | BindPaths=$ROOT/shop/data $ROOT/shop/cache" \
  "  | TemporaryFileSystem=$PFX/etc/wfos-apps:ro" "  | BindReadOnlyPaths=$PFX/etc/wfos-apps/start/shop.sh" \
  "  | InaccessiblePaths=-/root -/home -/etc/letsencrypt -/etc/wfos-app-helper.conf -/etc/nginx -$PFX/var/lib/wfos-apps -/var/log -/var/lib/cloud -/var/www -/mnt -/media -/usr/local/sbin" \
  "  | WantedBy=multi-user.target" \
  "[dry-run] systemctl daemon-reload" "[dry-run] systemctl enable wfos-app-shop.service"; do
  has "$line" "unit-install"
done
hasnt "DynamicUser" "unit-install"
hasnt "BindPaths=$ROOT/shop/releases" "unit-install: the running app cannot write its release"
hasnt "BindReadOnlyPaths=/run/wfos-apps-pg" "unit-install without --database: no pg socket"
helper_in 'pnpm start' unit-install shop 4100 512 --database
code 0 "unit-install --database"
has "  | BindReadOnlyPaths=/run/wfos-apps-pg" "unit-install --database"
has "postgresql@18-apps.service" "unit-install --database"
hasnt "InaccessiblePaths=-/run/wfos-apps-pg" "unit-install --database"
SD=255 helper_in 'pnpm start' unit-install shop 4100 512
hasnt "PrivatePIDs" "unit-install on systemd 255"
hasnt "next-cache" "unit-install without a current release binds no Next.js cache"
# the running release's .next/cache: the only writable spot in it, resolved from current when the unit is written
mkdir -p "$ROOT/shop/releases/$SHA/.next" "$ROOT/shop/next-cache"
ln -sfn "releases/$SHA" "$ROOT/shop/current"
helper_in 'pnpm start' unit-install shop 4100 512
code 0 "unit-install with a Next.js build"
has "  | BindPaths=$ROOT/shop/next-cache:$ROOT/shop/releases/$SHA/.next/cache" "unit-install binds the Next.js cache"
has "[dry-run] runuser -u wa-shop -g wfos-app-run -- mkdir -m 0700 -- $ROOT/shop/releases/$SHA/.next/cache" "the app user creates the mount point"
hasnt "BindPaths=$ROOT/shop/releases/$SHA " "the release itself stays read-only"
mkdir -p "$ROOT/shop/releases/$SHA/.next/cache"
helper_in 'pnpm start' unit-install shop 4100 512
code 0 "unit-install with .next/cache present"
hasnt "mkdir -m 0700" "unit-install with .next/cache present"
rm -rf "$ROOT/shop/releases/$SHA/.next/cache"
ln -s "$WORK/outside" "$ROOT/shop/releases/$SHA/.next/cache"
helper_in 'pnpm start' unit-install shop 4100 512
code 1 "unit-install with a symlinked .next/cache"
hasnt "[dry-run] write" "unit-install with a symlinked .next/cache"
rm -rf "$ROOT/shop/releases/$SHA/.next"
ln -s "$WORK/outside" "$ROOT/shop/releases/$SHA/.next"
helper_in 'pnpm start' unit-install shop 4100 512
code 1 "unit-install with a symlinked .next"
rm -f "$ROOT/shop/releases/$SHA/.next"
rm -rf "$ROOT/shop/next-cache"
helper_in 'pnpm start' unit-install shop 4100 512
code 0 "unit-install of a release without .next"
hasnt "next-cache" "no .next, no Next.js cache bind"
rm -f "$ROOT/shop/current"
pass "unit-install: start script + sandboxed unit as wa-<slug> (HOST=127.0.0.1, own port only, pg socket only with --database)"
pass "unit-install binds <app>/next-cache onto the running release's .next/cache (links refused, release stays read-only)"

helper unit-start shop
has "[dry-run] systemctl enable --now wfos-app-shop.service" "unit-start"
helper unit-stop shop
has "[dry-run] systemctl disable --now wfos-app-shop.service" "unit-stop"
hasnt "flock" "unit-stop never waits for a lock"
helper unit-restart shop
has "[dry-run] systemctl restart wfos-app-shop.service" "unit-restart"
for a in unit-start unit-restart; do
  WFOS_HELPER_TEST_FIREWALL=0 helper "$a" shop
  guarded firewall_off "$a without the app firewall"
  hasnt "[dry-run] systemctl" "$a without the app firewall"
  WFOS_HELPER_TEST_ACTIVE_UNITS="wfos-app-a.service wfos-app-b.service wfos-app-c.service" helper "$a" shop
  guarded server_full "$a with 3 apps running"
  WFOS_HELPER_TEST_ACTIVE_UNITS="wfos-app-a.service wfos-app-b.service wfos-app-shop.service" helper "$a" shop
  code 0 "$a: the app itself does not count"
done
DISK=100 helper unit-start shop
guarded disk_low "unit-start with low disk"
# the unit's Next.js cache bind must match the current release
mkdir -p "$ROOT/shop/releases/$SHA/.next/cache"
ln -sfn "releases/$SHA" "$ROOT/shop/current"
printf '[Service]\nBindPaths=%s\n' "$ROOT/shop/next-cache:$ROOT/shop/releases/$SHA2/.next/cache" > "$PFX/etc/systemd/system/wfos-app-shop.service"
helper unit-restart shop
code 1 "unit-restart with a stale Next.js cache bind"
has "run unit-install first" "unit-restart with a stale Next.js cache bind"
printf '[Service]\nBindPaths=%s\n' "$ROOT/shop/next-cache:$ROOT/shop/releases/$SHA/.next/cache" > "$PFX/etc/systemd/system/wfos-app-shop.service"
helper unit-restart shop
code 0 "unit-restart with a matching Next.js cache bind"
rm -rf "$ROOT/shop/releases/$SHA/.next/cache"
ln -s "$WORK/outside" "$ROOT/shop/releases/$SHA/.next/cache"
helper unit-start shop
code 1 "unit-start with a symlinked .next/cache"
rm -rf "$ROOT/shop/releases/$SHA/.next" "$ROOT/shop/current" "$PFX/etc/systemd/system/wfos-app-shop.service"
pass "unit-start/restart: firewall required, at most MAX_RUNNING apps (exit 3 server_full), disk guard on start, next-cache checks again"
helper unit-status shop
code 0 "unit-status"
last_line inactive "unit-status prints one word"
pass "unit-start/stop/restart/status"

helper health shop 4100 /api/health
code 1 "health in dry-run (no answer)"
has "--max-time 5" "health"
has "[dry-run] curl -q " "health ignores curlrc"
has "--max-redirs 0 --max-filesize 10485760" "health limits"
has "http://127.0.0.1:4100/api/health" "health"
last_line '{"status":0}' "health prints one JSON line"
pass "health curls 127.0.0.1:<port><path> as root and prints {\"status\":<code>}"

# --- publish / unpublish ----------------------------------------------------------------
rm -f "$PFX/var/lib/wfos-apps"/cert-count-* "$PFX/etc/nginx/sites-enabled"/* "$PFX/etc/nginx/conf.d"/*
helper_in "$BCRYPT" publish shop 4100 --auth
code 0 "publish --auth"
for line in \
  "[dry-run] write $PFX/etc/wfos-apps/htpasswd/shop (mode 0640, owner root:www-data)" \
  "(1 line: user preview, bcrypt hash)" \
  "[dry-run] write $PFX/var/lib/wfos-apps/cert-count-" \
  "certbot certonly --nginx -d shop.preview.example.com" \
  "--deploy-hook systemctl\ reload\ nginx" \
  "auth_basic_user_file /etc/wfos-apps/htpasswd/shop;" \
  "proxy_pass http://127.0.0.1:4100;" \
  'proxy_set_header Authorization "";' \
  'return 301 https://shop.preview.example.com$request_uri;' \
  'add_header X-Robots-Tag "noindex, nofollow" always;' \
  "[dry-run] nginx -t" "[dry-run] systemctl reload nginx" "published https://shop.preview.example.com"; do
  has "$line" "publish --auth"
done
hasnt '$2y$10$' "publish never prints the hash"
mkdir -p "$PFX/etc/letsencrypt/live/shop.preview.example.com"
touch "$PFX/etc/letsencrypt/live/shop.preview.example.com/fullchain.pem"
helper publish shop 4100
code 0 "publish without --auth"
has "[dry-run] rm -f -- $PFX/etc/wfos-apps/htpasswd/shop" "publish without --auth removes the htpasswd"
has "certificate for shop.preview.example.com present" "publish with a certificate"
hasnt "certbot" "publish with a certificate"
hasnt "auth_basic" "publish without --auth"
hasnt 'Authorization ""' "publish without --auth leaves Authorization alone"
hasnt 'https://$host' "the redirect never uses the request's Host"
printf 'server {\n  listen 80;\n  server_name wfos.example.com Shop.Preview.Example.com; # someone else\n}\n' > "$PFX/etc/nginx/sites-enabled/other"
helper publish shop 4100
guarded server_name_taken "publish over another site's server_name"
hasnt "[dry-run] write" "publish over another site's server_name"
rm -f "$PFX/etc/nginx/sites-enabled/other"
printf 'server { server_name "shop.preview.example.com"; }\n' > "$PFX/etc/nginx/conf.d/x.conf"
helper publish shop 4100
guarded server_name_taken "publish over a conf.d server_name"
rm -f "$PFX/etc/nginx/conf.d/x.conf"
printf 'http {\n  server {\n    server_name\n      shop.preview.example.com;\n  }\n}\n' > "$PFX/etc/nginx/nginx.conf"
helper publish shop 4100
guarded server_name_taken "publish over a server_name in nginx.conf (all that nginx -T shows)"
rm -f "$PFX/etc/nginx/nginx.conf"
printf 'server { server_name shop.preview.example.com; }\n' > "$PFX/etc/nginx/sites-enabled/wfos-app-shop"
printf 'server { server_name other-shop.preview.example.com; }\n' > "$PFX/etc/nginx/sites-enabled/wfos-app-other-shop"
helper publish shop 4100
code 0 "republish over its own site"
rm -f "$PFX/etc/nginx/sites-enabled"/*
rm -rf "$PFX/etc/letsencrypt/live/shop.preview.example.com"
echo 10 > "$PFX/var/lib/wfos-apps/cert-count-$(date -u +%Y%m%d)"
helper publish shop 4100
guarded cert_limit "publish with 10 certificates today"
hasnt "certbot" "publish with 10 certificates today"
echo 3 > "$PFX/var/lib/wfos-apps/cert-count-$(date -u +%Y%m%d)"
echo 9 > "$PFX/var/lib/wfos-apps/cert-count-20260101"
helper publish shop 4100
code 0 "publish with 3 certificates today"
has "[dry-run] rm -f -- $PFX/var/lib/wfos-apps/cert-count-20260101" "publish drops old counters"
has "  | 4" "publish counts the certificate"
rm -f "$PFX/var/lib/wfos-apps"/cert-count-*
pass "publish: htpasswd (hash never printed), certbot only without a certificate (≤ 10/day), refuses another site's server_name"

helper unpublish shop
code 0 "unpublish"
has "[dry-run] rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop $PFX/etc/nginx/sites-available/wfos-app-shop" "unpublish"
has "[dry-run] systemctl reload nginx" "unpublish"
hasnt "letsencrypt" "unpublish keeps the certificate"
pass "unpublish removes the site and keeps the certificate"

# --- instance names: a live environment is <slug>-live, a world of its own ---------------
rm -rf "${ROOT:?}/shop-live"
helper app-init shop-live
code 0 "app-init shop-live"
has "--comment Workforce\ OS\ app\ shop-live wa-shop-live" "app-init shop-live"
has "[dry-run] install -d -m 0755 -o root -g root $ROOT/shop-live $ROOT/shop-live/releases" "app-init shop-live"
has "[dry-run] install -d -m 0700 -o wa-shop-live -g wa-shop-live $ROOT/shop-live/data $ROOT/shop-live/cache $ROOT/shop-live/next-cache" "app-init shop-live"
NAME35="abcdefghijklmnopqrstuvwxyz1234-live"
[[ ${#NAME35} == 35 ]] || fail "test setup: NAME35 has 35 characters"
rm -rf "${ROOT:?}/$NAME35"
helper app-init "$NAME35"
code 0 "app-init with a 35-character instance name"
user="$(sed -nE 's/.*groupadd --system --gid [0-9]+ (wa-[a-z0-9-]+).*/\1/p' "$WORK/out")"
[[ -n "$user" && ${#user} -le 31 && "$user" == wa-abcdefghijklmnopqrs-* ]] || fail "35-character name user: ${user@Q}"
has "--comment Workforce\ OS\ app\ $NAME35 $user" "the marker names the whole instance"
helper app-init "${NAME35:0:28}"
has "wa-${NAME35:0:28}" "names up to 28 characters keep their v2 user name"
rm -rf "${ROOT:?}/${NAME35:0:28}"
fresh_app shop-live
helper_in "PORT=4101"$'\n'"APP_URL=https://shop.example.org"$'\n' env-install shop-live
code 0 "env-install shop-live"
has "[dry-run] write $PFX/etc/wfos-apps/env/shop-live.env (mode 0600, owner root:root)" "env-install shop-live"
printf 'local all postgres peer\nlocal app_shop app_shop peer map=wfos_app_shop\nlocal app_shop app_shop scram-sha-256\n' > "$PFX/etc/postgresql/18/apps/pg_hba.conf"
printf 'wfos_app_shop postgres app_shop\nwfos_app_shop wa-shop app_shop\n' > "$PFX/etc/postgresql/18/apps/pg_ident.conf"
helper_in "$PW" db-create shop-live
code 0 "db-create shop-live"
has "create role app_shop_live" "db-create shop-live: its own role and database"
hasline "  | local app_shop_live app_shop_live peer map=wfos_app_shop_live" "db-create shop-live"
hasline "  | wfos_app_shop_live wa-shop-live app_shop_live" "db-create shop-live: only its own user"
hasline "  | local app_shop app_shop peer map=wfos_app_shop" "db-create shop-live keeps the preview's lines"
hasntline "  | wfos_app_shop wa-shop-live app_shop" "the live user never maps to the preview's role"
helper_in "$PW" db-create "$NAME35"
has "create role app_abcdefghijklmnopqrstuvwxyz1234_live" "db-create with a 35-character name"
mkdir -p "$ROOT/shop-live/releases/$SHA"
helper_in "pnpm build" build-run shop-live "$SHA" build 1200 1536
code 0 "build-run shop-live"
has "--unit=wfos-build-shop-live.service" "build-run shop-live"
has "--uid=wa-shop-live --gid=wfos-app-run" "build-run shop-live"
has "-p BindReadOnlyPaths=$ROOT/shop-live -p BindPaths=$ROOT/shop-live/data\ $ROOT/shop-live/cache -p BindPaths=$ROOT/shop-live/releases/$SHA" "build-run shop-live"
has "-p EnvironmentFile=$PFX/etc/wfos-apps/env/shop-live.env" "build-run shop-live"
helper_in 'pnpm start' unit-install shop-live 4101 512 --database
code 0 "unit-install shop-live"
for line in "  | User=wa-shop-live" "  | BindReadOnlyPaths=$ROOT/shop-live" "  | BindPaths=$ROOT/shop-live/data $ROOT/shop-live/cache" \
  "  | EnvironmentFile=$PFX/etc/wfos-apps/env/shop-live.env" "  | ExecStart=/bin/sh $PFX/etc/wfos-apps/start/shop-live.sh" \
  "  | BindReadOnlyPaths=$PFX/etc/wfos-apps/start/shop-live.sh" "  | WorkingDirectory=$ROOT/shop-live/current" \
  "  | Environment=HOST=127.0.0.1 PORT=4101 NODE_ENV=production" "  | SocketBindAllow=tcp:4101"; do
  hasline "$line" "unit-install shop-live"
done
has "[dry-run] write $PFX/etc/systemd/system/wfos-app-shop-live.service" "unit-install shop-live"
hasntline "  | BindReadOnlyPaths=$ROOT/shop" "the live unit never sees the preview's folder"
hasntline "  | EnvironmentFile=$PFX/etc/wfos-apps/env/shop.env" "the live unit never reads the preview's env"
rm -f "$PFX/home/wfos-apps/incoming"/*.tar.gz
mkdir -p "$WORK/tlive" && echo x > "$WORK/tlive/a"
tar -czf "$PFX/home/wfos-apps/incoming/shop-live-$SHA2.tar.gz" -C "$WORK/tlive" .
helper release-unpack shop-live "$SHA2"
code 0 "release-unpack shop-live"
has "runuser -u wfos-apps -- cat -- $PFX/home/wfos-apps/incoming/shop-live-$SHA2.tar.gz | runuser -u wa-shop-live" "release-unpack shop-live reads <name>-<sha>.tar.gz"
has "[dry-run] install -d -m 0750 -o wa-shop-live -g wa-shop-live $ROOT/shop-live/releases/$SHA2" "release-unpack shop-live"
helper release-activate shop-live "$SHA"
code 0 "release-activate shop-live"
has "[dry-run] mv -fT -- $ROOT/shop-live/.current.wfos-tmp $ROOT/shop-live/current" "release-activate shop-live"
for c in unit-start unit-restart; do
  WFOS_HELPER_TEST_ACTIVE_UNITS="wfos-app-a.service wfos-app-b.service wfos-app-shop.service" helper "$c" shop-live
  guarded server_full "$c shop-live: the preview of the same app counts as a running app"
done
helper unit-stop shop-live
has "[dry-run] systemctl disable --now wfos-app-shop-live.service" "unit-stop shop-live"
helper health shop-live 4101 /api/health
has "http://127.0.0.1:4101/api/health" "health shop-live"
rm -rf "${ROOT:?}/shop-live/current"
pass "instance names: <slug>-live gets its own user, folders, env, start script, unit, build unit, database and upload name"
pass "instance names up to 35 characters (long ones hash to a 31-character user; up to 28 keep the v2 name)"

# --- publish with a live domain ------------------------------------------------------------
SITE_LIVE="$PFX/etc/nginx/sites-available/wfos-app-shop-live"
clean_nginx() {
  rm -f "$PFX/var/lib/wfos-apps"/cert-count-* "$PFX/etc/nginx/sites-enabled"/* "$PFX/etc/nginx/conf.d"/* "$PFX/etc/nginx/nginx.conf"
  rm -rf "$PFX/etc/letsencrypt/live"/*
}
clean_nginx
helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --alias shop.example.net --index
code 0 "publish --domain --alias --index"
has "[dry-run] certbot certonly --nginx --cert-name shop.example.org -d shop.example.org -d www.shop.example.org -d shop.example.net --keep-until-expiring --renew-with-new-domains --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook systemctl\ reload\ nginx" "one certificate for the domain and every alias"
[[ "$(grep -c 'certbot certonly' "$WORK/out")" == 1 ]] || fail "publish --domain asks certbot once"
[[ "$(grep -c "write $PFX/var/lib/wfos-apps/cert-count-" "$WORK/out")" == 1 ]] || fail "publish --domain counts one certificate"
has "  | 1" "the first certificate of the day"
has "[dry-run] write $SITE_LIVE (mode 0644, owner root:root)" "publish --domain writes the instance's site"
has "[dry-run] ln -sfn $SITE_LIVE $PFX/etc/nginx/sites-enabled/wfos-app-shop-live" "publish --domain enables it"
has "  |     server_name shop.example.org www.shop.example.org shop.example.net;" "the http site answers the challenge for every name"
has "redirect https://www.shop.example.org -> https://shop.example.org" "publish --domain names the redirects"
has "published https://shop.example.org" "publish --domain"
hasnt "shop-live.preview.example.com" "a live site never takes a preview name"
hasnt "X-Robots-Tag" "--index: no noindex header"
hasnt "auth_basic" "no basic auth without --auth"
hasnt 'Authorization ""' "no basic auth without --auth"
site_blocks "$SITE_LIVE"
[[ -f "$WORK/blk.1" && -f "$WORK/blk.2" && -f "$WORK/blk.3" && ! -f "$WORK/blk.4" ]] || fail "live site: three server blocks (http, the domain, the aliases)"
grep -qF "server_name shop.example.org www.shop.example.org shop.example.net;" "$WORK/blk.1" || fail "live site: http for every name"
grep -qF 'return 301 https://shop.example.org$request_uri;' "$WORK/blk.1" || fail "live site: http redirects to https://<domain>"
grep -qxF "    server_name shop.example.org;" "$WORK/blk.2" || fail "live site: the https site serves the domain only"
grep -qF "proxy_pass http://127.0.0.1:4101;" "$WORK/blk.2" || fail "live site: the domain is proxied to the app"
grep -qF "ssl_certificate /etc/letsencrypt/live/shop.example.org/fullchain.pem;" "$WORK/blk.2" || fail "live site: the domain's certificate"
grep -qxF "    server_name www.shop.example.org shop.example.net;" "$WORK/blk.3" || fail "live site: the alias block"
grep -qF "listen 443 ssl;" "$WORK/blk.3" || fail "live site: aliases answer https"
grep -qF "ssl_certificate /etc/letsencrypt/live/shop.example.org/fullchain.pem;" "$WORK/blk.3" || fail "live site: aliases share the certificate"
grep -qF 'return 301 https://shop.example.org$request_uri;' "$WORK/blk.3" || fail "live site: aliases redirect (301) to the domain"
! grep -qF "proxy_pass" "$WORK/blk.3" || fail "live site: aliases are never proxied"
! grep -qF 'https://$host' "$WORK/blk.1" "$WORK/blk.3" || fail "live site: redirects never use the request's Host"
pass "publish --domain: one certificate for domain + aliases (counted once), http for every name, aliases 301 to https://<domain>"
pass "publish --index omits noindex; no basic auth without --auth"

clean_nginx
helper publish shop-live 4101 --domain shop.example.org
code 0 "publish --domain without --index"
has 'add_header X-Robots-Tag "noindex, nofollow" always;' "publish --domain without --index keeps noindex"
has "certbot certonly --nginx --cert-name shop.example.org -d shop.example.org --keep-until-expiring" "publish --domain without aliases"
site_blocks "$SITE_LIVE"
[[ -f "$WORK/blk.2" && ! -f "$WORK/blk.3" ]] || fail "live site without aliases: no alias block"
clean_nginx
helper_in "$BCRYPT" publish shop-live 4101 --index --domain shop.example.org --auth --alias www.shop.example.org
code 0 "publish options in another order, with --auth"
has "[dry-run] write $PFX/etc/wfos-apps/htpasswd/shop-live (mode 0640, owner root:www-data)" "publish --domain --auth"
has "auth_basic_user_file /etc/wfos-apps/htpasswd/shop-live;" "publish --domain --auth"
has 'auth_basic "Private";' "publish --domain --auth"
has 'proxy_set_header Authorization "";' "publish --domain --auth"
hasnt '$2y$10$' "publish --domain never prints the hash"
site_blocks "$SITE_LIVE"
! grep -qF "auth_basic" "$WORK/blk.3" || fail "the alias redirect needs no password"
clean_nginx
helper publish shop 4100
code 0 "preview publish in v3"
has "[dry-run] certbot certonly --nginx -d shop.preview.example.com --keep-until-expiring --non-interactive" "a preview certificate is requested as in v2"
hasnt "--cert-name" "a preview certificate is requested as in v2"
has 'add_header X-Robots-Tag "noindex, nofollow" always;' "previews stay noindex"
site_blocks "$PFX/etc/nginx/sites-available/wfos-app-shop"
[[ -f "$WORK/blk.2" && ! -f "$WORK/blk.3" ]] || fail "preview site: two server blocks as in v2"
clean_nginx
helper_in "$BCRYPT" publish shop 4100 --auth
has 'auth_basic "Preview";' "preview realm unchanged"
pass "publish --domain: noindex unless --index, basic auth only with --auth (options in any order); previews unchanged"

# the certificate: kept when it covers exactly the names, requested again (and counted) when they changed
if command -v openssl > /dev/null; then
  mkcert() {
    local dir="$PFX/etc/letsencrypt/live/$1" san="$2"
    mkdir -p "$dir"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$WORK/key.pem" -out "$dir/fullchain.pem" \
      -days 2 -subj "/CN=$1" -addext "subjectAltName=$san" > /dev/null 2>&1 || fail "test setup: openssl req"
  }
  clean_nginx
  mkcert shop.example.org "DNS:shop.example.org,DNS:www.shop.example.org"
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --index
  code 0 "publish --domain with a matching certificate"
  has "certificate for shop.example.org present" "a matching certificate is kept"
  hasnt "certbot" "a matching certificate is kept"
  hasnt "cert-count" "a kept certificate is not counted"
  echo 10 > "$PFX/var/lib/wfos-apps/cert-count-$(date -u +%Y%m%d)"
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --index
  code 0 "publish --domain with a matching certificate at the daily cap"
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --alias shop.example.net
  guarded cert_limit "a new alias at the daily cap"
  hasnt "certbot" "a new alias at the daily cap"
  hasnt "[dry-run] write" "a new alias at the daily cap"
  rm -f "$PFX/var/lib/wfos-apps"/cert-count-*
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --alias shop.example.net
  code 0 "publish --domain with a new alias"
  has "covers shop.example.org www.shop.example.org instead of shop.example.net shop.example.org www.shop.example.org" "a new alias: the certificate is requested again"
  has "--cert-name shop.example.org -d shop.example.org -d www.shop.example.org -d shop.example.net --keep-until-expiring --renew-with-new-domains" "a new alias: one certificate for all names"
  has "  | 1" "a new alias counts one certificate"
  helper publish shop-live 4101 --domain shop.example.org
  code 0 "publish --domain with a dropped alias"
  has "--cert-name shop.example.org -d shop.example.org --keep-until-expiring --renew-with-new-domains" "a dropped alias leaves the certificate too"
  rm -f "$PFX/var/lib/wfos-apps"/cert-count-*
  mkcert shop.example.org "DNS:SHOP.example.org"
  helper publish shop-live 4101 --domain shop.example.org
  code 0 "certificate names compare case-insensitively"
  hasnt "certbot" "certificate names compare case-insensitively"
  echo "not a certificate" > "$PFX/etc/letsencrypt/live/shop.example.org/fullchain.pem"
  helper publish shop-live 4101 --domain shop.example.org
  code 0 "an unreadable certificate"
  has "certbot certonly" "an unreadable certificate is requested again"
  pass "publish --domain keeps a certificate that covers exactly its names, else requests one (≤ 10 a day, counted once)"
else
  echo "skip - openssl is not installed (certificate name checks)"
fi

# refusals: bad host names, preview names, too many or repeated names (exit 2, nothing run)
clean_nginx
LABEL64="$(printf 'a%.0s' {1..64})"
LONG254="$(printf 'abcdefghi.%.0s' {1..25})abcd"
[[ ${#LONG254} == 254 ]] || fail "test setup: LONG254"
for args in \
  "--domain shop.preview.example.com" "--domain preview.example.com" "--domain a.b.preview.example.com" \
  "--domain shop.example.org --alias www.preview.example.com" "--domain shop.example.org --alias preview.example.com" \
  "--domain Shop.example.org" "--domain shop" "--domain 1.2.3.4" "--domain *.example.org" "--domain -a.example.org" \
  "--domain a-.example.org" "--domain a_b.example.org" "--domain a..b.org" "--domain .example.org" "--domain example.org." \
  "--domain $LABEL64.example.org" "--domain $LONG254" "--domain shop.example.org/x" "--domain shop.example.org:443" \
  "--domain shop.example.1" "--domain a.b" \
  "--domain shop.example.org --alias a.example.org --alias b.example.org --alias c.example.org --alias d.example.org" \
  "--alias www.shop.example.org" "--domain shop.example.org --alias shop.example.org" \
  "--domain shop.example.org --alias www.example.org --alias www.example.org" \
  "--domain shop.example.org --domain shop.example.net" "--domain shop.example.org --index --index" \
  "--auth --auth" "--domain" "--domain shop.example.org --alias" "--alias=www.shop.example.org" \
  "--domain shop.example.org extra" "--domain=shop.example.org" "--noindex" "--domain shop.example.org --alias Bad.example.org"; do
  # shellcheck disable=SC2086 # word splitting builds the argument list on purpose
  helper_in "$BCRYPT" publish shop-live 4101 $args
  rejected "publish $args"
done
helper publish shop-live 4101 --domain "shop.example.org"$'\n'"x"
rejected "publish --domain with a newline"
helper publish shop-live 4101 --domain ""
rejected "publish --domain with an empty name"
helper publish "shop live" 4101 --domain shop.example.org
rejected "publish with a bad instance name"
helper publish shop-live 4099 --domain shop.example.org
rejected "publish --domain with a bad port"
helper publish shop-live 4101 --domain shop.example.org --alias a.example.org --alias b.example.org --alias c.example.org
code 0 "publish with 3 aliases"
pass "publish refuses bad host names, the preview domain and names under it, > 3 aliases, repeated names, stray options (exit 2)"

# names another site serves (exact for every name; wildcards of other sites for live names)
taken_by() {
  clean_nginx
  printf 'server {\n  listen 80;\n  server_name %s; # someone else\n}\n' "$1" > "$PFX/etc/nginx/sites-enabled/other"
}
for t in "www.shop.example.org" "shop.example.org" "WWW.Shop.Example.org" "*.shop.example.org" ".example.org" "shop.example.*" "www.shop.*"; do
  taken_by "$t"
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org
  guarded server_name_taken "publish --domain over another site's server_name $t"
  hasnt "[dry-run] write" "publish --domain over another site's server_name $t"
  hasnt "certbot" "publish --domain over another site's server_name $t"
done
taken_by "shop.example.net"
helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --alias shop.example.net
guarded server_name_taken "an alias another site serves"
has "another nginx site already serves shop.example.net" "the refusal names the alias"
for t in "*.example.net" "example.org" "*.org.example" "shop.example.org.evil" "~^shop\.example\.org$"; do
  taken_by "$t"
  helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org
  code 0 "publish --domain next to a site with $t"
done
# the preview catch-all (a wildcard by design) never blocks a preview, nor a live domain (never under it)
clean_nginx
printf 'server {\n  listen 80;\n  server_name preview.example.com *.preview.example.com;\n  return 404;\n}\n' > "$PFX/etc/nginx/sites-enabled/wfos-apps-catchall"
helper publish shop 4100
code 0 "a preview next to the catch-all"
helper publish shop-live 4101 --domain shop.example.org
code 0 "a live domain next to the catch-all"
printf 'server { server_name shop.example.org www.shop.example.org; }\n' > "$PFX/etc/nginx/sites-enabled/wfos-app-shop-live"
helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org
code 0 "republish over its own live site"
helper publish shop 4100 --domain shop.example.org
guarded server_name_taken "the preview instance cannot take the live instance's domain"
clean_nginx
pass "publish refuses a name (domain or alias) another site serves, incl. other sites' wildcards for live names (exit 3)"

helper unpublish shop-live
code 0 "unpublish shop-live"
has "[dry-run] rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop-live $SITE_LIVE" "unpublish shop-live"
hasnt "letsencrypt" "unpublish shop-live keeps the certificate"
pass "unpublish of a live instance removes only its site"

# --- app-remove / stop-all -------------------------------------------------------------
fresh_app shop
printf 'local all postgres peer\nlocal app_shop app_shop scram-sha-256\n' > "$PFX/etc/postgresql/18/apps/pg_hba.conf"
helper app-remove shop --drop-db
code 0 "app-remove --drop-db"
for line in \
  "[dry-run] systemctl disable --now wfos-app-shop.service" \
  "[dry-run] rm -f -- $PFX/etc/systemd/system/wfos-app-shop.service" \
  "[dry-run] systemctl stop wfos-build-shop.service" \
  "[dry-run] rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop" \
  "[dry-run] rm -f -- $PFX/etc/wfos-apps/env/shop.env $PFX/etc/wfos-apps/start/shop.sh $PFX/etc/wfos-apps/htpasswd/shop" \
  "DROP DATABASE IF EXISTS app_shop WITH (FORCE); DROP ROLE IF EXISTS app_shop" \
  "[dry-run] rm -rf --one-file-system -- $ROOT/shop" \
  "app shop removed"; do
  has "$line" "app-remove"
done
hasnt "local app_shop app_shop" "app-remove drops the pg_hba line"
helper app-remove evil
code 0 "app-remove of a planted symlink"
has "[dry-run] rm -f -- $ROOT/evil" "app-remove removes the link itself"
hasnt "rm -rf --one-file-system -- $ROOT/evil" "app-remove never recurses through a link"
helper app-remove shop
hasnt "DROP DATABASE" "app-remove without --drop-db keeps the database"
fresh_app shop
helper app-remove shop --drop-db
[[ "$(grep -n 'systemctl stop wfos-build-shop.service' "$WORK/out" | cut -d: -f1)" -lt "$(grep -n 'flock' "$WORK/out" | cut -d: -f1)" ]] || fail "app-remove stops the build before taking the lock"
has "  | " "app-remove rewrites pg_hba/pg_ident"
hasnt "wfos_app_shop" "app-remove drops the peer map"
pass "app-remove removes unit, site, env/start/htpasswd, the app folder (links not followed) and with --drop-db the database"

helper stop-all
code 0 "stop-all without apps"
has "no app units" "stop-all without apps"
has "[dry-run] systemctl stop wfos-build-\*.service" "stop-all stops running builds"
hasnt "flock" "stop-all never waits for a lock"
touch "$PFX/etc/systemd/system/wfos-app-shop.service" "$PFX/etc/systemd/system/wfos-app-blog.service" "$PFX/etc/systemd/system/other.service"
helper stop-all
code 0 "stop-all"
has "[dry-run] systemctl disable --now wfos-app-blog.service wfos-app-shop.service" "stop-all"
hasnt "other.service" "stop-all only touches app units"
pass "stop-all stops and disables every wfos-app-* unit"
touch "$PFX/etc/systemd/system/wfos-app-shop-live.service" "$PFX/etc/systemd/system/wfos-app-$NAME35.service"
helper stop-all
has "wfos-app-$NAME35.service" "stop-all includes 35-character instance names"
has "wfos-app-shop-live.service" "stop-all includes live instances"
rm -f "$PFX/etc/systemd/system"/*.service
fresh_app shop-live
fresh_app shop
helper app-remove shop-live --drop-db
code 0 "app-remove shop-live --drop-db"
has "DROP DATABASE IF EXISTS app_shop_live WITH (FORCE); DROP ROLE IF EXISTS app_shop_live" "app-remove shop-live drops only its database"
has "[dry-run] rm -rf --one-file-system -- $ROOT/shop-live" "app-remove shop-live"
has "[dry-run] rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop-live $PFX/etc/nginx/sites-available/wfos-app-shop-live" "app-remove shop-live"
hasline "[dry-run] rm -rf --one-file-system -- $ROOT/shop-live" "app-remove shop-live"
hasntline "[dry-run] rm -rf --one-file-system -- $ROOT/shop" "app-remove shop-live keeps the preview's folder"
hasnt "DROP DATABASE IF EXISTS app_shop " "app-remove shop-live keeps the preview's database"
hasnt "wa-shop " "app-remove shop-live keeps the preview's user"
pass "stop-all and app-remove handle live instances; removing one environment never touches the other"

# --- app-remove --keep-db-dump -------------------------------------------------------------
for args in "shop --keep-db-dump" "shop --drop-db --drop-db" "shop --keep-db-dump --keep-db-dump --drop-db" "shop --keep" \
  "shop --drop-db --keep-db-dump extra" "shop --drop-db=1"; do
  # shellcheck disable=SC2086 # word splitting builds the argument list on purpose
  helper app-remove $args
  rejected "app-remove $args"
done
REMOVED="$PFX/var/lib/wfos-apps/removed"
rm -rf "$REMOVED"
fresh_app shop-live
helper app-remove shop-live --keep-db-dump --drop-db
code 0 "app-remove --keep-db-dump --drop-db (any order)"
has "[dry-run] install -d -m 0700 -o root -g root $REMOVED" "the dump folder is created when missing"
has "[dry-run] runuser -u postgres -- /usr/lib/postgresql/18/bin/pg_dump -h /run/wfos-apps-pg -p 5433 -U app_shop_live -Fc -d app_shop_live > $REMOVED/shop-live-" "the dump runs as the app role"
dump="$(tail -1 "$WORK/out")"
[[ "$dump" =~ ^"kept database dump: $REMOVED/shop-live-"[0-9]{8}T[0-9]{4}Z\.dump$ ]] || fail "app-remove --keep-db-dump: last line names the dump, got ${dump@Q}"
has "${dump#kept database dump: } (root-owned, mode 0600, via a temp file)" "the dump goes where the last line says"
n_dump="$(grep -n 'pg_dump' "$WORK/out" | head -1 | cut -d: -f1)"
for later in "systemctl disable --now wfos-app-shop-live.service" "rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop-live" \
  "DROP DATABASE IF EXISTS app_shop_live" "rm -rf --one-file-system -- $ROOT/shop-live"; do
  [[ "$n_dump" -lt "$(grep -nF -- "$later" "$WORK/out" | head -1 | cut -d: -f1)" ]] || fail "the dump comes before: $later"
done
[[ "$(grep -n 'flock' "$WORK/out" | head -1 | cut -d: -f1)" -lt "$n_dump" ]] || fail "the dump runs under the lock"
mkdir -p "$REMOVED"
touch -d "40 days ago" "$REMOVED/old-20260101T0000Z.dump"
touch -d "5 days ago" "$REMOVED/recent-20260101T0000Z.dump"
fresh_app shop-live
helper app-remove shop-live --drop-db --keep-db-dump
code 0 "app-remove --keep-db-dump with older dumps"
has "[dry-run] rm -f -- $REMOVED/old-20260101T0000Z.dump" "dumps older than 30 days are pruned"
hasnt "recent-20260101T0000Z.dump" "newer dumps are kept"
hasnt "install -d -m 0700 -o root -g root $REMOVED" "an existing dump folder is used as it is"
rm -rf "$REMOVED"
ln -s "$WORK/outside" "$REMOVED"
fresh_app shop-live
helper app-remove shop-live --drop-db --keep-db-dump
code 1 "app-remove --keep-db-dump into a symlinked folder"
has "nothing was removed" "app-remove --keep-db-dump into a symlinked folder"
hasnt "systemctl disable" "a failed dump removes nothing"
hasnt "DROP DATABASE" "a failed dump removes nothing"
hasnt "rm -rf" "a failed dump removes nothing"
rm -f "$REMOVED"
fresh_app shop-live
helper app-remove shop-live --drop-db
code 0 "app-remove --drop-db without --keep-db-dump"
hasnt "pg_dump" "no dump without --keep-db-dump"
hasnt "kept database dump" "no dump without --keep-db-dump"
pass "app-remove --keep-db-dump (needs --drop-db): dump as the app role first, then remove; last line names it; 30 days kept"

# --- certificates of a removed instance ------------------------------------------------------
DOMAINS="$PFX/var/lib/wfos-apps/domains"
clean_nginx
rm -rf "$DOMAINS"
helper publish shop-live 4101 --domain shop.example.org --alias www.shop.example.org --index
code 0 "publish --domain records its domain"
has "[dry-run] install -d -m 0700 -o root -g root $DOMAINS" "the record folder is created when missing"
has "[dry-run] write $DOMAINS/shop-live (mode 0600, owner root:root)" "publish --domain records its domain"
has "  | shop.example.org" "publish --domain records its domain"
mkdir -p "$DOMAINS" "$PFX/etc/letsencrypt/live/shop.example.org" "$PFX/etc/letsencrypt/live/shop.preview.example.com"
echo shop.example.org > "$DOMAINS/shop-live"
helper publish shop-live 4101 --domain shop.example.org --index
hasnt "write $DOMAINS/shop-live" "the same domain is not recorded again"
hasnt "certbot delete" "the same domain keeps its certificate"
helper publish shop-live 4101 --domain shop.example.net --index
code 0 "publish with another domain"
has "  | shop.example.net" "the new domain is recorded"
has "[dry-run] certbot delete --cert-name shop.example.org --non-interactive" "the replaced domain gives up its certificate"
[[ "$(grep -n 'certbot delete' "$WORK/out" | cut -d: -f1)" -gt "$(grep -n "write $PFX/etc/nginx/sites-available/wfos-app-shop-live" "$WORK/out" | tail -1 | cut -d: -f1)" ]] || fail "the old certificate goes only after the new site is in place"
helper publish shop 4100
hasnt "certbot delete" "a preview publish never deletes a certificate"
hasnt "$DOMAINS/shop " "a preview publish records nothing"

clean_nginx
mkdir -p "$PFX/etc/letsencrypt/live/shop.example.org" "$PFX/etc/letsencrypt/live/shop.preview.example.com"
echo shop.example.org > "$DOMAINS/shop-live"
fresh_app shop-live
helper app-remove shop-live --drop-db
code 0 "app-remove of a live instance"
has "[dry-run] certbot delete --cert-name shop.example.org --non-interactive" "app-remove deletes the live certificate"
has "[dry-run] rm -f -- $DOMAINS/shop-live" "app-remove drops the domain record"
hasnt "cert-name shop.preview.example.com" "app-remove of the live instance keeps the preview's certificate"
[[ "$(grep -n 'certbot delete' "$WORK/out" | cut -d: -f1)" -gt "$(grep -n "rm -f -- $PFX/etc/nginx/sites-enabled/wfos-app-shop-live" "$WORK/out" | cut -d: -f1)" ]] || fail "the certificate goes after the site"
last_line "app shop-live removed" "app-remove without --keep-db-dump"
fresh_app shop
helper app-remove shop --drop-db
code 0 "app-remove of a preview instance"
has "[dry-run] certbot delete --cert-name shop.preview.example.com --non-interactive" "app-remove deletes the preview certificate too"
hasnt "cert-name shop.example.org" "app-remove of the preview keeps the live certificate"
# no record (published by v2/v3 before the record existed): the site names the certificate
rm -f "$DOMAINS/shop-live"
mkdir -p "$PFX/etc/nginx/sites-available"
printf 'server {\n    server_name shop.example.org;\n    ssl_certificate /etc/letsencrypt/live/shop.example.org/fullchain.pem;\n}\n' > "$PFX/etc/nginx/sites-available/wfos-app-shop-live"
fresh_app shop-live
helper app-remove shop-live
has "[dry-run] certbot delete --cert-name shop.example.org --non-interactive" "without a record the site names the certificate"
rm -f "$PFX/etc/nginx/sites-available/wfos-app-shop-live"
# never someone else's
echo shop.example.org > "$DOMAINS/shop-live"
echo shop.example.org > "$DOMAINS/other-live"
fresh_app shop-live
helper app-remove shop-live
code 0 "app-remove with a certificate another instance uses"
has "certificate shop.example.org kept: instance other-live uses it" "a certificate another instance records is kept"
hasnt "certbot delete --cert-name shop.example.org" "a certificate another instance records is kept"
rm -f "$DOMAINS/other-live"
echo shop.example.org > "$DOMAINS/shop-live"
printf 'server { server_name shop.example.org; }\n' > "$PFX/etc/nginx/sites-enabled/other"
fresh_app shop-live
helper app-remove shop-live
has "certificate shop.example.org kept: another nginx site serves shop.example.org" "a certificate another site serves is kept"
hasnt "certbot delete --cert-name shop.example.org" "a certificate another site serves is kept"
rm -f "$PFX/etc/nginx/sites-enabled/other"
printf '../../etc/passwd\n' > "$DOMAINS/shop-live"
rm -rf "$PFX/etc/letsencrypt/live"/*
fresh_app shop-live
helper app-remove shop-live
code 0 "app-remove with a bad record"
hasnt "certbot delete" "a record that is not a host name is ignored"
has "no certificate shop-live.preview.example.com" "no lineage, nothing to delete"
clean_nginx
rm -rf "$DOMAINS"
pass "app-remove deletes the instance's certificates (preview and live; best effort, never another's); a replaced live domain too"

# --- prepare.sh --------------------------------------------------------------
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXcRLnEUF79Xv5t7O1ZIxo7NbQ5VM/aN67ad/RUhWRA wfos-acme"
prepare() {
  set +e
  WFOS_PREPARE_TEST_FRESH=1 WFOS_PREPARE_TEST_OLD_CONF="${OLD_CONF:-$WORK/none.conf}" bash "${PREPARE_SCRIPT:-$PREPARE}" "$@" > "$WORK/out" 2>&1
  CODE=$?
  set -e
}
printf 'USER=wfos-apps\nBASE_DOMAIN=preview.example.com\nPG_PORT=5433\nAPPS_ROOT=/home/wfos-apps/apps\nPORT_MIN=4100\nPORT_MAX=4499\n' > "$WORK/a1.conf"
OLD_CONF="$WORK/a1.conf" prepare --dry-run --public-key "$KEY" --domain Preview.Example.com
code 0 "prepare --dry-run"
for line in \
  "DRY RUN: nothing below is executed or written" \
  "no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty $KEY" \
  "write /home/wfos-apps/.ssh/authorized_keys as wfos-apps" \
  "[dry-run] runuser -u wfos-apps -- install -d -m 0750 /home/wfos-apps/incoming" \
  "wfos-apps ALL=(root) NOPASSWD: /usr/local/sbin/wfos-app-helper" \
  "visudo -cf /etc/sudoers.d/wfos-app-helper" \
  "install -o root -g root -m 0755 $HELPER /usr/local/sbin/wfos-app-helper" \
  "BASE_DOMAIN=preview.example.com" "PG_PORT=5433" "PORT_MIN=4100" "PORT_MAX=4499" "PG_VERSION=" \
  "MAX_RUNNING=3" "MAX_APPS=20" \
  "log_statement = 'none'" "log_min_error_statement = panic" \
  "[dry-run] write /etc/systemd/system/wfos-apps.slice" "  | MemoryMax=40%" "  | MemoryHigh=35%" "  | CPUQuota=200%" "  | TasksMax=2048" "  | IOWeight=50" \
  "fib daddr type { local, broadcast, multicast, anycast } reject" \
  "server_names_hash_bucket_size 512;" \
  "[dry-run] write /etc/nginx/sites-available/wfos-apps-catchall" "  |     server_name preview.example.com *.preview.example.com;" "  |     ssl_reject_handshake on;" \
  "[dry-run] ln -sfn /etc/nginx/sites-available/wfos-apps-catchall /etc/nginx/sites-enabled/wfos-apps-catchall" \
  "168.63.129.16/32" "192.0.0.0/24" "198.18.0.0/15" "64:ff9b::/96" \
  "APPS_ROOT=/srv/wfos-apps" \
  "APPS_ROOT moves from /home/wfos-apps/apps to /srv/wfos-apps" \
  "[dry-run] runuser -u wfos-apps -- rmdir --ignore-fail-on-non-empty -- /home/wfos-apps/apps" \
  "[dry-run] install -d -m 0755 -o root -g root /srv/wfos-apps /etc/wfos-apps /etc/wfos-apps/start" \
  "[dry-run] install -d -m 0700 -o root -g root /etc/wfos-apps/env /var/lib/wfos-apps" \
  "[dry-run] install -d -m 0700 -o root -g root /var/lib/wfos-apps/domains /var/lib/wfos-apps/removed" \
  "[dry-run] install -d -m 0750 -o root -g www-data /etc/wfos-apps/htpasswd" \
  "[dry-run] install -d -m 0755 -o root -g root /opt/wfos-apps /opt/wfos-apps/corepack" \
  "corepack prepare pnpm@10.33.0 --activate" \
  "COREPACK_HOME=/opt/wfos-apps/corepack" \
  "listen_addresses = ''" \
  "unix_socket_directories = '/run/wfos-apps-pg'" \
  "d /run/wfos-apps-pg 0750 postgres wfos-app-run -" \
  "  | local all postgres peer" \
  "REVOKE\ CONNECT\ ON\ DATABASE\ template1\ FROM\ PUBLIC" \
  "[dry-run] write /etc/wfos-apps/nftables.conf (mode 0644, owner root:root)" \
  "  | table inet wfos_apps" "  | delete table inet wfos_apps" \
  "jump app_output" \
  "ct state established,related accept" \
  "th dport 53 ip daddr @dns4 accept" \
  "127.0.0.53" \
  "0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 168.63.129.16/32, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3" \
  "::/128, ::1/128, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8" \
  'iifname != "lo" tcp dport 4100-4499 drop' \
  "[dry-run] write /etc/systemd/system/wfos-apps-firewall.service" \
  "  | ExecStart=/usr/sbin/nft -f /etc/wfos-apps/nftables.conf" \
  "  | WantedBy=sysinit.target" \
  "[dry-run] nft -c -f /etc/wfos-apps/nftables.conf" \
  "[dry-run] systemctl enable wfos-apps-firewall.service" \
  "DRY RUN finished: nothing was changed"; do
  has "$line" "prepare --dry-run"
done
hasnt "WFOS_SERVER_READY" "prepare --dry-run"
hasnt "flush ruleset" "prepare never flushes other tables"
hasnt "listen_addresses=localhost" "prepare: no TCP for the apps cluster"
hasnt "@own4" "prepare: no static own-address list (fib covers it)"
grep -qE '^  \| 		meta skgid ([0-9]+|<gid of wfos-app-run>) jump app_output$' "$WORK/out" || fail "prepare: the output chain matches the wfos-app-run gid"
# every action is printed, never run: only [dry-run] lines may name a command that changes the system
if grep -vE '^\[dry-run\]|^  \| ' "$WORK/out" | grep -qE '(^| )(apt-get|useradd|groupadd|pg_createcluster|pg_ctlcluster|visudo|ufw allow|systemctl (reload|enable|start|daemon-reload)|nft -f|corepack prepare|systemd-tmpfiles)( |$)'; then
  fail "prepare --dry-run printed an action outside a [dry-run] line"
fi
pass "prepare.sh --dry-run: user, key, sudo rule, config (APPS_ROOT migration), corepack pnpm, socket-only pg, nft table + boot unit"

prepare --dry-run --public-key "$KEY" --domain preview.example.com
code 0 "prepare without an earlier install"
hasnt "APPS_ROOT moves" "prepare without an earlier install"
pass "prepare.sh without an earlier config does not migrate anything"

prepare --dry-run --public-key "$KEY" --domain apps.example.org --user appsbot --pg-port 5544 --pnpm-version 10.12.1 --max-running 5 --max-apps 40 --node-major 22
code 0 "prepare custom user/port"
has "MAX_RUNNING=5" "prepare --max-running"
has "MAX_APPS=40" "prepare --max-apps"
has "gpg --dearmor > /etc/apt/keyrings/nodesource.gpg" "prepare: NodeSource keyring"
has "  | deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" "prepare: signed NodeSource repo"
hasnt "setup_22.x" "prepare: no downloaded setup script run as root"
has "appsbot ALL=(root) NOPASSWD: /usr/local/sbin/wfos-app-helper" "prepare --user"
has "USER=appsbot" "prepare --user"
has "corepack prepare pnpm@10.12.1 --activate" "prepare --pnpm-version"
pass "prepare.sh honours --user, --pg-port and --pnpm-version"

for args in \
  "--domain preview.example.com" \
  "--public-key ssh-rsa_AAAAB3NzaC1yc2E --domain preview.example.com" \
  "--public-key ssh-ed25519 --domain preview.example.com"; do
  # shellcheck disable=SC2086 # word splitting builds the argument list on purpose
  prepare --dry-run $args
  code 2 "prepare $args"
done
for key in "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 x" "$KEY"$'\n'"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXcRLnEUF79Xv5t7O1ZIxo7NbQ5VM/aN67ad/RUhWRA evil" \
  "command=\"id\" $KEY" "$KEY two words"; do
  prepare --dry-run --public-key "$key" --domain preview.example.com
  code 2 "prepare with key ${key@Q}"
done
for dom in "exa mple.com" "-x.example.com" localhost "a/b.com" "x.com;id" ""; do
  prepare --dry-run --public-key "$KEY" --domain "$dom"
  code 2 "prepare with domain ${dom@Q}"
done
for u in root Bad "a b" "x;id"; do
  prepare --dry-run --public-key "$KEY" --domain preview.example.com --user "$u"
  code 2 "prepare with user ${u@Q}"
done
for p in 5432 80 abc 70000; do
  prepare --dry-run --public-key "$KEY" --domain preview.example.com --pg-port "$p"
  code 2 "prepare with pg port ${p@Q}"
done
for v in 9.15.0 latest 10.x "10.1.1;id"; do
  prepare --dry-run --public-key "$KEY" --domain preview.example.com --pnpm-version "$v"
  code 2 "prepare with pnpm version ${v@Q}"
done
for v in 0 51 x; do
  prepare --dry-run --public-key "$KEY" --domain preview.example.com --max-running "$v"
  code 2 "prepare with max running ${v@Q}"
  prepare --dry-run --public-key "$KEY" --domain preview.example.com --max-apps "${v/51/401}"
  code 2 "prepare with max apps ${v@Q}"
done
prepare --dry-run --public-key "$KEY" --domain preview.example.com --node-major latest
code 2 "prepare with node major latest"
prepare --dry-run --public-key "$KEY" --domain preview.example.com --bogus
code 2 "prepare with an unknown option"
pass "prepare.sh refuses bad keys (one ed25519 line, no options), domains, users, ports and pnpm versions"

mkdir "$WORK/alone"
cp "$PREPARE" "$WORK/alone/prepare.sh"
PREPARE_SCRIPT="$WORK/alone/prepare.sh" prepare --dry-run --public-key "$KEY" --domain preview.example.com
code 1 "prepare without the helper next to it"
has "wfos-app-helper must be next to prepare.sh" "prepare without the helper"
pass "prepare.sh needs wfos-app-helper next to it"

# --- shellcheck (only when installed) ---------------------------------------
if command -v shellcheck > /dev/null; then
  shellcheck -s bash "$HELPER" "$PREPARE" "${BASH_SOURCE[0]}" || fail "shellcheck"
  pass "shellcheck"
else
  echo "skip - shellcheck is not installed"
fi

echo "all $PASS app-server checks passed"
