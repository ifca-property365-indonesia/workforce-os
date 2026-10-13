#!/usr/bin/env bash
# Exercises deploy/app-server/{wfos-app-helper,prepare.sh} in their dry-run modes only, with a temporary helper
# config: the helper answers version and info and refuses everything else (exit 2); a bad config stops it;
# prepare.sh prints every action and refuses bad input. Nothing is installed, written outside the temp dir or run.
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

ROOT="$WORK/apps"
mkdir -p "$ROOT"
cat > "$WORK/conf" << EOF
# test config
USER=wfos-apps
BASE_DOMAIN=preview.example.com
PG_PORT=5433
APPS_ROOT=$ROOT
PORT_MIN=4100
PORT_MAX=4499
EOF

# helper ARGS... (stdin passed through): dry-run with the temp config; output in $WORK/out, exit code in $CODE
helper() {
  set +e
  WFOS_HELPER_DRY_RUN=1 WFOS_HELPER_CONF="${CONF_FILE:-$WORK/conf}" "$HELPER" "$@" > "$WORK/out" 2>&1
  CODE=$?
  set -e
}
has() { grep -qF -- "$1" "$WORK/out" || fail "$2: expected output to contain: $1"; }
hasnt() { ! grep -qF -- "$1" "$WORK/out" || fail "$2: expected output not to contain: $1"; }
code() { [[ "$CODE" == "$1" ]] || fail "$2: expected exit $1, got $CODE"; }
# a rejected call: exit 2, one-line error, nothing it would run or write
rejected() {
  code 2 "$1"
  hasnt "[dry-run]" "$1"
  [[ "$(wc -l < "$WORK/out")" -le 1 ]] || fail "$1: expected a one-line error"
}

# --- version / info --------------------------------------------------------
helper version
code 0 "version"
[[ "$(cat "$WORK/out")" == 1 ]] || fail "version prints 1"
pass "version prints 1"

helper info < /dev/null
code 0 "info"
json="$(tail -1 "$WORK/out")"
if command -v node > /dev/null; then
  node -e 'const j = JSON.parse(process.argv[1]); if (j.helperVersion !== 1 || j.baseDomain !== "preview.example.com" || typeof j.nginx !== "boolean" || typeof j.diskFreeMb !== "number" || !("postgresPort" in j)) process.exit(1)' "$json" || fail "info JSON shape: $json"
elif command -v jq > /dev/null; then
  jq -e '.helperVersion == 1 and .baseDomain == "preview.example.com" and (.nginx | type == "boolean")' <<< "$json" > /dev/null || fail "info JSON shape: $json"
fi
pass "info prints one JSON line with helperVersion and baseDomain"

# --- argument validation ----------------------------------------------------
helper frobnicate shop
rejected "unknown command"
helper
rejected "no command"
helper version extra
rejected "version with an argument"
helper info extra < /dev/null
rejected "info with an argument"
pass "unknown commands and wrong argument counts exit 2"

# the run/build/publish/db commands come with Phase A2: until then the helper must not know them
for gone in unit-install unit-start unit-stop unit-restart unit-status unit-remove build-run publish unpublish db-create db-dump; do
  helper "$gone" shop 4100 512 < /dev/null
  rejected "$gone"
done
pass "Phase A2 commands are not available yet"

# --- config validation -------------------------------------------------------
bad_conf() {
  sed "$1" "$WORK/conf" > "$WORK/bad.conf"
  CONF_FILE="$WORK/bad.conf" helper info < /dev/null
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
bad_conf 's/^USER=.*/USER wfos-apps/' "a line without ="
[[ ! -e pwned && ! -e "$WORK/pwned" ]] || fail "config values must never be executed"
CONF_FILE="$WORK/missing.conf" helper info < /dev/null
code 1 "missing config"
pass "a bad or missing config stops the helper"

# --- prepare.sh --------------------------------------------------------------
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXcRLnEUF79Xv5t7O1ZIxo7NbQ5VM/aN67ad/RUhWRA wfos-acme"
prepare() {
  set +e
  bash "${PREPARE_SCRIPT:-$PREPARE}" "$@" > "$WORK/out" 2>&1
  CODE=$?
  set -e
}
prepare --dry-run --public-key "$KEY" --domain Preview.Example.com
code 0 "prepare --dry-run"
for line in \
  "DRY RUN: nothing below is executed or written" \
  "no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty $KEY" \
  "wfos-apps ALL=(root) NOPASSWD: /usr/local/sbin/wfos-app-helper" \
  "visudo -cf /etc/sudoers.d/wfos-app-helper" \
  "install -o root -g root -m 0755 $HELPER /usr/local/sbin/wfos-app-helper" \
  "BASE_DOMAIN=preview.example.com" "PG_PORT=5433" "PORT_MIN=4100" "PORT_MAX=4499" \
  "[dry-run] install -d -m 0750 -o root -g www-data /etc/nginx/wfos-apps" \
  "DRY RUN finished: nothing was changed"; do
  has "$line" "prepare --dry-run"
done
hasnt "WFOS_SERVER_READY" "prepare --dry-run"
# every action is printed, never run: only [dry-run] lines may name a command that changes the system
if grep -vE '^\[dry-run\]|^  \| ' "$WORK/out" | grep -qE '(^| )(apt-get|useradd|pg_createcluster|visudo|ufw allow|systemctl reload)( |$)'; then
  fail "prepare --dry-run printed an action outside a [dry-run] line"
fi
pass "prepare.sh --dry-run prints the user, key options, sudo rule, helper config and nginx folder"

prepare --dry-run --public-key "$KEY" --domain apps.example.org --user appsbot --pg-port 5544
code 0 "prepare custom user/port"
has "appsbot ALL=(root) NOPASSWD: /usr/local/sbin/wfos-app-helper" "prepare --user"
has "USER=appsbot" "prepare --user"
has "PG_PORT=5544" "prepare --pg-port"
pass "prepare.sh honours --user and --pg-port"

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
prepare --dry-run --public-key "$KEY" --domain preview.example.com --node-major latest
code 2 "prepare with node major latest"
prepare --dry-run --public-key "$KEY" --domain preview.example.com --bogus
code 2 "prepare with an unknown option"
pass "prepare.sh refuses bad keys (one ed25519 line, no options), domains, users and ports"

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
