#!/usr/bin/env bash
# Workforce OS — prepare a server to run the apps a workspace's employees build (App factory, Phase A).
# Run it yourself as root on that server, with wfos-app-helper next to it (copy both files). Idempotent: re-run it
# safely, e.g. to update the helper, after changing the domain, or to upgrade an earlier install in place.
#
#   sudo bash prepare.sh --public-key "ssh-ed25519 AAAA… wfos-<workspace>" --domain preview.example.com \
#     [--user wfos-apps] [--pg-port 5433] [--node-major 24] [--pnpm-version 10.33.0] [--max-running 3] \
#     [--max-apps 20] [--dry-run]
#
# What it does (each step skips what is already in place):
#   - apt: nginx, certbot (+ nginx plugin), openssl, PostgreSQL, nftables, jq, git, rsync, build-essential
#   - Node.js <node-major> from NodeSource's signed apt repository when node is missing or another major; pnpm
#     <pnpm-version> prepared by
#     corepack into /opt/wfos-apps/corepack (shared, read-only for the apps: no download at run time)
#   - the group wfos-app-run (every app user's processes run with it; the firewall matches it)
#   - a system user (default wfos-apps) without sudo rights, its ~/incoming upload folder, and the workspace's public
#     key in its authorized_keys (no agent / port / X11 forwarding, no pty)
#   - /srv/wfos-apps (the apps), /etc/wfos-apps/{env,start,htpasswd} (root-owned app config), /var/lib/wfos-apps
#     (+ domains/, removed/: the helper's records and kept database dumps), /etc/wfos-apps/maintenance.html (the
#     neutral page a live site shows during a release that migrates its database)
#   - a separate PostgreSQL cluster "apps" on <pg-port>, reachable only through its socket in /run/wfos-apps-pg (no
#     TCP at all); each app gets its own role and database later (the helper's db-create)
#   - the app firewall: nftables table inet wfos_apps (only that table, nothing else is flushed), loaded now and at
#     boot by wfos-apps-firewall.service: apps cannot open connections to this host, private networks or the
#     server's own addresses (DNS excepted), and app ports (4100-4899: 4500 and up are the second port of each live
#     app, for releases without downtime) are reachable from loopback only
#   - wfos-apps.slice: every app and build runs in it, so together they never take more than 40 % of the memory,
#     two CPUs and 2048 tasks; the helper starts at most <max-running> apps and creates at most <max-apps>
#   - /usr/local/sbin/wfos-app-helper (root:root 0755) + a sudoers rule that lets the user run exactly that file
#   - /etc/wfos-app-helper.conf and an nginx websocket map
#   - ufw: allow 80 and 443 when ufw is active
# At the end it prints this server's SSH host key fingerprint (compare it with the one Workforce OS shows before you
# confirm) and WFOS_SERVER_READY. Workforce OS never sees a root password: everything root does later goes through
# the helper, which validates every argument.
#
# --dry-run prints every action instead of doing it (no changes at all; does not need root).
set -euo pipefail
export LC_ALL=C

USER_NAME=wfos-apps PG_PORT=5433 NODE_MAJOR=24 PNPM_VERSION=10.33.0 MAX_RUNNING=3 MAX_APPS=20 DOMAIN="" PUBLIC_KEY="" DRY=0
HELPER_DST=/usr/local/sbin/wfos-app-helper
SUDOERS=/etc/sudoers.d/wfos-app-helper
CONF=/etc/wfos-app-helper.conf
# 4100-4499: one port per app environment; 4500-4899: the second (green) slot of each live environment (port + 400)
PORT_MIN=4100 PORT_MAX=4899
APPS_ROOT=/srv/wfos-apps
ETC_APPS=/etc/wfos-apps
STATE_DIR=/var/lib/wfos-apps
COREPACK_DIR=/opt/wfos-apps/corepack
RUN_GROUP=wfos-app-run
PG_SOCK=/run/wfos-apps-pg
NFT_CONF=$ETC_APPS/nftables.conf
FW_UNIT=/etc/systemd/system/wfos-apps-firewall.service
SLICE_UNIT=/etc/systemd/system/wfos-apps.slice
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_SRC="$HERE/wfos-app-helper"

die() { echo "prepare.sh: $*" >&2; exit 2; }
fail() { echo "prepare.sh: $*" >&2; exit 1; }
step() { echo "== $*"; }
warn() { echo "warning: $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-key) [[ $# -ge 2 ]] || die "--public-key needs a value"; PUBLIC_KEY="$2"; shift 2 ;;
    --domain) [[ $# -ge 2 ]] || die "--domain needs a value"; DOMAIN="$2"; shift 2 ;;
    --user) [[ $# -ge 2 ]] || die "--user needs a value"; USER_NAME="$2"; shift 2 ;;
    --pg-port) [[ $# -ge 2 ]] || die "--pg-port needs a value"; PG_PORT="$2"; shift 2 ;;
    --node-major) [[ $# -ge 2 ]] || die "--node-major needs a value"; NODE_MAJOR="$2"; shift 2 ;;
    --pnpm-version) [[ $# -ge 2 ]] || die "--pnpm-version needs a value"; PNPM_VERSION="$2"; shift 2 ;;
    --max-running) [[ $# -ge 2 ]] || die "--max-running needs a value"; MAX_RUNNING="$2"; shift 2 ;;
    --max-apps) [[ $# -ge 2 ]] || die "--max-apps needs a value"; MAX_APPS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,36p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# validation: every value ends up in files root reads, so only exact shapes pass
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN,,}"
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
KEY_RE='^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{40,80}={0,2}( [!-~]{1,100})?$'
[[ -n "$PUBLIC_KEY" ]] || die "--public-key is required (copy it from Workforce OS: Settings → Servers)"
[[ "$PUBLIC_KEY" =~ $KEY_RE ]] || die "--public-key must be one OpenSSH ed25519 public key line (ssh-ed25519 AAAA… comment)"
[[ -n "$DOMAIN" ]] || die "--domain is required (the wildcard domain apps are served under, e.g. preview.example.com)"
[[ ${#DOMAIN} -le 200 && "$DOMAIN" =~ $DOMAIN_RE ]] || die "--domain ${DOMAIN@Q} is not a valid domain name"
[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$USER_NAME" != root ]] || die "--user ${USER_NAME@Q} is not a valid user name"
[[ "$PG_PORT" =~ ^[1-9][0-9]{3,4}$ ]] && ((PG_PORT >= 1024 && PG_PORT <= 65535 && PG_PORT != 5432)) || die "--pg-port must be 1024..65535 and not 5432"
[[ "$NODE_MAJOR" =~ ^[1-9][0-9]$ ]] && ((NODE_MAJOR >= 20)) || die "--node-major must be a Node.js major version (20 or later)"
[[ "$PNPM_VERSION" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "--pnpm-version must be an exact pnpm 10 version (e.g. 10.33.0)"
[[ "$MAX_RUNNING" =~ ^[1-9][0-9]?$ ]] && ((MAX_RUNNING <= 50)) || die "--max-running must be 1..50"
[[ "$MAX_APPS" =~ ^[1-9][0-9]{0,2}$ ]] && ((MAX_APPS <= 400)) || die "--max-apps must be 1..400"
[[ -f "$HELPER_SRC" ]] || fail "wfos-app-helper must be next to prepare.sh ($HELPER_SRC)"
[[ "$DRY" == 1 || "$(id -u)" == 0 ]] || fail "run as root (sudo bash prepare.sh …), or try --dry-run"
# the helper is copied once into a root-only temp folder, checked there and installed from there: the folder this
# script was copied to may be writable by someone else, who must not swap the file between check and install
HELPER_COPY="$HELPER_SRC"
if [[ "$DRY" == 0 ]]; then
  HELPER_TMP="$(mktemp -d)"
  trap 'rm -rf -- "$HELPER_TMP"' EXIT
  HELPER_COPY="$HELPER_TMP/wfos-app-helper"
  cp -- "$HELPER_SRC" "$HELPER_COPY"
fi
bash -n "$HELPER_COPY" || fail "$HELPER_SRC has a syntax error"

if [[ -r /etc/os-release ]]; then
  OS_ID="$(sed -nE 's/^ID="?([^"]*)"?$/\1/p' /etc/os-release | head -1)"
  OS_LIKE="$(sed -nE 's/^ID_LIKE="?([^"]*)"?$/\1/p' /etc/os-release | head -1)"
else
  OS_ID="" OS_LIKE=""
fi
[[ "$OS_ID" == ubuntu || "$OS_ID" == debian || " $OS_LIKE " == *" debian "* ]] || fail "only Ubuntu and Debian are supported (found ${OS_ID:-unknown})"

# the config of an earlier install (APPS_ROOT moves); a dry-run test may point at its own copy
OLD_CONF="$CONF"
if [[ "$DRY" == 1 && -n "${WFOS_PREPARE_TEST_OLD_CONF:-}" ]]; then OLD_CONF="$WFOS_PREPARE_TEST_OLD_CONF"; fi

[[ "$DRY" == 1 ]] && echo "DRY RUN: nothing below is executed or written"

# ---------------------------------------------------------------------------
# dry-run aware actions
# ---------------------------------------------------------------------------
run() {
  if [[ "$DRY" == 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# write_file PATH MODE OWNER:GROUP < content — atomic (temp file in the same directory, then mv). Only for paths
# below root-owned directories; files in the apps user's home are written as that user (as_user_write).
write_file() {
  local path="$1" mode="$2" owner="$3" tmp
  if [[ "$DRY" == 1 ]]; then
    echo "[dry-run] write $path (mode $mode, owner $owner)"
    sed 's/^/  | /'
    echo "[dry-run] end $path"
    return 0
  fi
  [[ ! -L "$path" ]] || fail "$path is a symlink: refusing to write through it"
  tmp="$(mktemp "$(dirname "$path")/.wfos-tmp.XXXXXX")"
  cat > "$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  mv -fT "$tmp" "$path"
}

# dry-run tests set WFOS_PREPARE_TEST_FRESH=1: every step then prints what it would do, even on a prepared host
fresh_test() { [[ "$DRY" == 1 && "${WFOS_PREPARE_TEST_FRESH:-}" == 1 ]]; }

# write_if_changed PATH MODE OWNER < content: like write_file, but only when the content differs; returns 0 when it
# wrote (or would write), 1 when the file was already like that
write_if_changed() {
  local path="$1" content
  content="$(cat)"
  if ! fresh_test && [[ -f "$path" && ! -L "$path" && "$(cat "$path")" == "$content" ]]; then
    echo "$path unchanged"
    return 1
  fi
  printf '%s\n' "$content" | write_file "$@"
}

# as_user_write USER PATH < content: write a file in USER's own home with USER's rights (root never writes there:
# the user could have replaced a folder in its home by a symlink to /root or /etc)
as_user_write() {
  local user="$1" path="$2"
  if [[ "$DRY" == 1 ]]; then
    echo "[dry-run] write $path as $user (mode 0600)"
    sed 's/^/  | /'
    echo "[dry-run] end $path"
    return 0
  fi
  # shellcheck disable=SC2016 # expanded by the user's sh
  runuser -u "$user" -- /bin/sh -c 'umask 077 && cat > "$1.wfos-tmp" && mv -f "$1.wfos-tmp" "$1"' sh "$path"
}

installed() { dpkg-query -W -f='${Status}' "$1" 2> /dev/null | grep -q "install ok installed"; }

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
step "packages"
# ---------------------------------------------------------------------------
missing=()
for p in ca-certificates curl gnupg jq git rsync build-essential; do
  installed "$p" || missing+=("$p")
done
# these may come from elsewhere (a snap certbot, a PostgreSQL major already installed): keep what is there
command -v nginx > /dev/null || missing+=(nginx)
command -v nft > /dev/null || missing+=(nftables)
# the helper reads which names a live site's certificate covers (openssl x509)
command -v openssl > /dev/null || missing+=(openssl)
certbot_path="$(command -v certbot || true)"
[[ -n "$certbot_path" ]] || missing+=(certbot)
[[ "$certbot_path" == /snap/* ]] || installed python3-certbot-nginx || missing+=(python3-certbot-nginx)
compgen -G '/usr/lib/postgresql/*/bin/postgres' > /dev/null || missing+=(postgresql)
if [[ ${#missing[@]} -gt 0 ]]; then
  run apt-get update -q
  run apt-get install -y --no-install-recommends "${missing[@]}"
else
  echo "all present"
fi

# ---------------------------------------------------------------------------
step "Node.js $NODE_MAJOR and pnpm $PNPM_VERSION"
# ---------------------------------------------------------------------------
current_major=""
command -v node > /dev/null && current_major="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || true)"
if [[ "$current_major" != "$NODE_MAJOR" ]]; then
  [[ -n "$current_major" ]] && warn "node $current_major is installed; replacing it with $NODE_MAJOR (NodeSource)"
  # NodeSource's signed apt repository (their documented manual setup), not a downloaded script run as root: apt
  # then checks every package against this keyring
  NS_KEY=/etc/apt/keyrings/nodesource.gpg
  NS_LIST=/etc/apt/sources.list.d/nodesource.list
  run install -d -m 0755 /etc/apt/keyrings
  if [[ "$DRY" == 1 ]]; then
    echo "[dry-run] curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor > $NS_KEY (mode 0644)"
  else
    nskey="$(mktemp)"
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor > "$nskey"
    [[ -s "$nskey" ]] || fail "could not fetch the NodeSource signing key"
    install -m 0644 -o root -g root "$nskey" "$NS_KEY"
    rm -f -- "$nskey"
  fi
  echo "deb [signed-by=$NS_KEY] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | write_file "$NS_LIST" 0644 root:root
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' | write_file /etc/apt/preferences.d/nodesource 0644 root:root
  run apt-get update -q
  run apt-get install -y nodejs
else
  echo "node $(node -v) present"
fi
command -v corepack > /dev/null || [[ "$DRY" == 1 ]] || fail "corepack is missing (it ships with Node.js up to 24; install it with: npm install -g corepack)"
command -v pnpm > /dev/null || run corepack enable
# one shared, root-owned pnpm for every app user: COREPACK_HOME is read-only for them and the sandbox never
# downloads (COREPACK_ENABLE_NETWORK=0), so "--activate" makes this version the default
run install -d -m 0755 -o root -g root /opt/wfos-apps "$COREPACK_DIR"
if ! fresh_test && [[ -d "$COREPACK_DIR/v1/pnpm/$PNPM_VERSION" ]] && grep -qs "\"$PNPM_VERSION\"" "$COREPACK_DIR/lastKnownGood.json"; then
  echo "pnpm $PNPM_VERSION present in $COREPACK_DIR"
else
  run env COREPACK_HOME="$COREPACK_DIR" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@$PNPM_VERSION" --activate
fi
run chmod -R a+rX "$COREPACK_DIR"

# ---------------------------------------------------------------------------
step "group $RUN_GROUP and user $USER_NAME"
# ---------------------------------------------------------------------------
if ! fresh_test && getent group "$RUN_GROUP" > /dev/null; then
  echo "group $RUN_GROUP exists"
else
  run groupadd --system "$RUN_GROUP"
fi
if id -u "$USER_NAME" > /dev/null 2>&1; then
  echo "user exists"
  for g in $(id -nG "$USER_NAME"); do
    [[ "$g" == sudo || "$g" == admin || "$g" == wheel || "$g" == root || "$g" == "$RUN_GROUP" ]] && fail "user $USER_NAME is in group $g; it must not have rights beyond the helper"
  done
  HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
else
  run useradd --create-home --shell /bin/bash --user-group "$USER_NAME"
  HOME_DIR="/home/$USER_NAME"
fi
[[ "$HOME_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$HOME_DIR" != / ]] || fail "unexpected home directory ${HOME_DIR@Q} for $USER_NAME"
# the home itself sits in root-owned /home; everything inside it is created by the user, never by root
run install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR"
run runuser -u "$USER_NAME" -- install -d -m 0700 "$HOME_DIR/.ssh"
run runuser -u "$USER_NAME" -- install -d -m 0750 "$HOME_DIR/incoming"

# authorized_keys: our line replaces an older line with the same key; other keys stay (read and written as the user)
KEY_BLOB="$(cut -d' ' -f2 <<< "$PUBLIC_KEY")"
KEY_LINE="no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty $PUBLIC_KEY"
AUTH_KEYS="$HOME_DIR/.ssh/authorized_keys"
{
  if [[ "$DRY" == 0 ]]; then
    runuser -u "$USER_NAME" -- cat "$AUTH_KEYS" 2> /dev/null | grep -vF -- " $KEY_BLOB" || true
  else
    echo "(other keys already in $AUTH_KEYS stay)"
  fi
  printf '%s\n' "$KEY_LINE"
} | as_user_write "$USER_NAME" "$AUTH_KEYS"

# sshd must let the user in with a key
if command -v sshd > /dev/null; then
  sshd_cfg="$(sshd -T 2> /dev/null || true)"
  if grep -qiE '^allowusers ' <<< "$sshd_cfg" && ! grep -iE '^allowusers ' <<< "$sshd_cfg" | grep -qw -- "$USER_NAME"; then
    warn "sshd AllowUsers does not include $USER_NAME: add it, or Workforce OS cannot connect"
  fi
  if grep -qiE '^allowgroups ' <<< "$sshd_cfg"; then
    warn "sshd has AllowGroups: make sure $USER_NAME is in one of them"
  fi
  if grep -qiE '^pubkeyauthentication no' <<< "$sshd_cfg"; then
    warn "sshd has PubkeyAuthentication no: Workforce OS needs key authentication"
  fi
fi

# ---------------------------------------------------------------------------
step "folders"
# ---------------------------------------------------------------------------
for d in "$APPS_ROOT" "$ETC_APPS" "$STATE_DIR"; do
  [[ ! -L "$d" ]] || fail "$d is a symlink; remove it first"
done
# APPS_ROOT holds every app's root-owned structure; nobody else may write it
run install -d -m 0755 -o root -g root "$APPS_ROOT" "$ETC_APPS" "$ETC_APPS/start"
run install -d -m 0700 -o root -g root "$ETC_APPS/env" "$STATE_DIR"
# the helper's own records: domains/ (the live domain each instance published, for its certificate) and removed/
# (database dumps kept by app-remove --keep-db-dump, 30 days)
for d in "$STATE_DIR/domains" "$STATE_DIR/removed"; do
  [[ ! -L "$d" ]] || fail "$d is a symlink; remove it first"
done
run install -d -m 0700 -o root -g root "$STATE_DIR/domains" "$STATE_DIR/removed"
# nginx workers (www-data) read the preview passwords
run install -d -m 0750 -o root -g www-data "$ETC_APPS/htpasswd"
# the page a live site shows while its release migrates the database (helper publish --maintenance: HTTP 503 with
# Retry-After): neutral, no product name, no external resources; nginx reads it, so it stays world-readable
write_if_changed "$ETC_APPS/maintenance.html" 0644 root:root << 'EOF' || true
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="60">
<title>Back in a moment</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f3; color: #1c1c1a;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 34rem; padding: 2.5rem 1.25rem; text-align: center; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
  hr { width: 3rem; margin: 2rem auto; border: 0; border-top: 1px solid currentColor; opacity: .25; }
  @media (prefers-color-scheme: dark) { body { background: #161615; color: #ececea; } }
</style>
</head>
<body>
<main>
  <h1>We&rsquo;ll be right back</h1>
  <p>This site is being updated. Please try again in a minute.</p>
  <hr>
  <h1 lang="id">Sebentar lagi kembali</h1>
  <p lang="id">Situs ini sedang diperbarui. Silakan coba lagi dalam satu menit.</p>
</main>
</body>
</html>
EOF

# A1 kept apps in ~/apps of the apps user; they live in root-owned /srv/wfos-apps now (C1: root never works in a
# folder a user controls). The old folder was always empty (A1 ran no apps): the user removes it if it still is.
old_root=""
if [[ -f "$OLD_CONF" ]]; then old_root="$(sed -nE 's/^APPS_ROOT=(.*)$/\1/p' "$OLD_CONF" | head -1)"; fi
if [[ -n "$old_root" && "$old_root" != "$APPS_ROOT" ]]; then
  echo "APPS_ROOT moves from $old_root to $APPS_ROOT"
  if [[ "$old_root" == "$HOME_DIR/apps" ]]; then
    if [[ "$DRY" == 1 ]]; then
      run runuser -u "$USER_NAME" -- rmdir --ignore-fail-on-non-empty -- "$old_root"
    else
      runuser -u "$USER_NAME" -- rmdir -- "$old_root" 2> /dev/null || warn "$old_root is not empty (or already gone); it is no longer used"
    fi
  else
    warn "$old_root is no longer used; remove it when it holds nothing you need"
  fi
fi

# ---------------------------------------------------------------------------
step "PostgreSQL cluster \"apps\" (socket only, in $PG_SOCK)"
# ---------------------------------------------------------------------------
if command -v pg_lsclusters > /dev/null; then
  existing="$(pg_lsclusters --no-header 2> /dev/null | awk '$2 == "apps" { print $1 " " $3 " " $4 }' | head -1)"
  taken="$(pg_lsclusters --no-header 2> /dev/null | awk -v p="$PG_PORT" '$3 == p && $2 != "apps" { print $1 "/" $2 }' | head -1)"
else
  existing="" taken=""
fi
pg_state=""
if [[ -n "$existing" ]]; then
  read -r pg_ver pg_port_now pg_state <<< "$existing"
  echo "exists ($pg_ver/apps, port $pg_port_now, $pg_state)"
  if [[ "$pg_port_now" != "$PG_PORT" ]]; then
    # with no TCP the port only names the socket file (.s.PGSQL.<port>); keep the cluster's own
    warn "cluster apps uses port $pg_port_now, not $PG_PORT; keeping $pg_port_now"
    PG_PORT="$pg_port_now"
  fi
else
  [[ -z "$taken" ]] || fail "port $PG_PORT is already used by PostgreSQL cluster $taken; choose another --pg-port"
  pg_ver="$(ls /usr/lib/postgresql 2> /dev/null | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
  if [[ -z "$pg_ver" ]]; then
    [[ "$DRY" == 1 ]] || fail "no PostgreSQL server found under /usr/lib/postgresql"
    pg_ver="18"
    echo "(dry-run: assuming PostgreSQL $pg_ver)"
  fi
  run pg_createcluster "$pg_ver" apps --port "$PG_PORT" -o shared_buffers=64MB -o max_connections=50
fi
PG_DIR="/etc/postgresql/$pg_ver/apps"
PSQL="/usr/lib/postgresql/$pg_ver/bin/psql"

# the socket folder: postgres creates the socket, only app processes (group wfos-app-run) may reach it; /run is a
# tmpfs, so systemd-tmpfiles creates it again at every boot (before PostgreSQL starts)
write_if_changed /etc/tmpfiles.d/wfos-apps-pg.conf 0644 root:root << EOF || true
# Workforce OS (prepare.sh): socket folder of the apps-only PostgreSQL cluster
d $PG_SOCK 0750 postgres $RUN_GROUP -
EOF
run systemd-tmpfiles --create /etc/tmpfiles.d/wfos-apps-pg.conf

if [[ -f "$PG_DIR/postgresql.conf" ]] && ! grep -qE "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$PG_DIR/postgresql.conf"; then
  fail "$PG_DIR/postgresql.conf has no include_dir = 'conf.d' (needed for the socket-only settings)"
fi
pg_changed=0 hba_changed=0
# conf.d comes last in postgresql.conf, so these win over what pg_createcluster (or A1: localhost) wrote
write_if_changed "$PG_DIR/conf.d/90-wfos-apps.conf" 0644 postgres:postgres << EOF && pg_changed=1
# Managed by Workforce OS prepare.sh: the apps cluster has no TCP at all; apps reach it through the socket only.
listen_addresses = ''
unix_socket_directories = '$PG_SOCK'
password_encryption = 'scram-sha-256'
# CREATE ROLE … PASSWORD from the helper must never land in a log, not even when a statement fails
log_statement = 'none'
log_min_error_statement = panic
EOF
# pg_hba: postgres by peer, each app role only to its own database (db-create adds a peer line with the app's own
# map, then a scram line); the app lines of earlier runs are kept
hba_lines=""
if [[ -f "$PG_DIR/pg_hba.conf" ]]; then
  hba_lines="$(grep -E '^[[:space:]]*local[[:space:]]+(app_[a-z0-9_]+)[[:space:]]+\1[[:space:]]+(scram-sha-256|peer[[:space:]]+map=wfos_\1)[[:space:]]*$' "$PG_DIR/pg_hba.conf" || true)"
fi
{
  echo "# Managed by Workforce OS (prepare.sh writes the header, wfos-app-helper db-create the app lines)."
  echo "# Socket only: postgres by peer; each app role only to its own database (peer through its map, else refused)."
  echo "local all postgres peer"
  [[ -z "$hba_lines" ]] || printf '%s\n' "$hba_lines"
} | write_if_changed "$PG_DIR/pg_hba.conf" 0640 postgres:postgres && hba_changed=1

# restart only when the settings changed or the running cluster is not socket-only yet; else reload for pg_hba
socket_only() {
  [[ -S "$PG_SOCK/.s.PGSQL.$PG_PORT" ]] &&
    [[ "$(runuser -u postgres -- "$PSQL" -X -At -h "$PG_SOCK" -p "$PG_PORT" -d postgres -c 'SHOW listen_addresses' 2> /dev/null)" == "" ]] &&
    runuser -u postgres -- "$PSQL" -X -At -h "$PG_SOCK" -p "$PG_PORT" -d postgres -c 'SELECT 1' > /dev/null 2>&1
}
if [[ "$DRY" == 1 ]]; then
  if [[ "$pg_state" != online* ]]; then
    run pg_ctlcluster "$pg_ver" apps start
  elif [[ "$pg_changed" == 1 || ! -S "$PG_SOCK/.s.PGSQL.$PG_PORT" ]]; then
    run pg_ctlcluster "$pg_ver" apps restart
  elif [[ "$hba_changed" == 1 ]]; then
    run pg_ctlcluster "$pg_ver" apps reload
  fi
else
  if ! pg_lsclusters --no-header 2> /dev/null | awk '$2 == "apps" && $4 ~ /^online/ { f = 1 } END { exit !f }'; then
    pg_ctlcluster "$pg_ver" apps start
  elif [[ "$pg_changed" == 1 ]] || ! socket_only; then
    pg_ctlcluster "$pg_ver" apps restart
  elif [[ "$hba_changed" == 1 ]]; then
    pg_ctlcluster "$pg_ver" apps reload
  fi
  socket_only || fail "the apps cluster does not answer on $PG_SOCK only (see /var/log/postgresql/postgresql-$pg_ver-apps.log)"
  echo "apps cluster: socket only ($PG_SOCK/.s.PGSQL.$PG_PORT)"
fi
# app roles may connect to their own database only (superusers are not affected)
run runuser -u postgres -- "$PSQL" -X -q -v ON_ERROR_STOP=1 -h "$PG_SOCK" -p "$PG_PORT" -d postgres \
  -c "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC" -c "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC"

# ---------------------------------------------------------------------------
step "app firewall (nftables table inet wfos_apps)"
# ---------------------------------------------------------------------------
gid="$(getent group "$RUN_GROUP" | cut -d: -f3 || true)"
if [[ -z "$gid" ]]; then
  [[ "$DRY" == 1 ]] || fail "group $RUN_GROUP is missing"
  gid="<gid of $RUN_GROUP>"
fi
V4_RE='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
V6_RE='^[0-9a-fA-F:]*:[0-9a-fA-F:]*$'
# DNS: the local stub resolver and whatever /etc/resolv.conf names (link-local resolvers with a %zone are skipped)
dns4=(127.0.0.53) dns6=()
while read -r addr; do
  if [[ "$addr" =~ $V4_RE && "$addr" != 127.0.0.53 ]]; then dns4+=("$addr"); fi
  if [[ "$addr" =~ $V6_RE ]]; then dns6+=("$addr"); fi
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf 2> /dev/null)

# set_block NAME TYPE [interval] ELEMENTS...: an nft set (no elements line when empty)
set_block() {
  local name="$1" type="$2" flags="$3"
  shift 3
  printf '\tset %s {\n\t\ttype %s\n' "$name" "$type"
  [[ -z "$flags" ]] || printf '\t\tflags %s\n' "$flags"
  if (($# > 0)); then
    local IFS=,
    local joined="$*"
    printf '\t\telements = { %s }\n' "${joined//,/, }"
  fi
  printf '\t}\n'
}
nft_content="$(
  cat << EOF
#!/usr/sbin/nft -f
# Managed by Workforce OS prepare.sh (re-run it to change this file). Loaded by wfos-apps-firewall.service.
# Only the table inet wfos_apps is replaced: other tables (ufw, docker, your own) are never touched.
# Processes of apps and builds run with primary group $RUN_GROUP (gid $gid): they may answer connections and use DNS,
# but never open connections to an address of this host (fib: local, broadcast, multicast, anycast; also when the
# addresses change), private networks, link-local, CGNAT or other special ranges (the public internet stays
# reachable, e.g. for npm). App ports $PORT_MIN-$PORT_MAX answer loopback only.
table inet wfos_apps
delete table inet wfos_apps
table inet wfos_apps {
EOF
  # 168.63.129.16: the Azure host agent; 192.0.0.0/24 and 198.18.0.0/15: IETF special use; 64:ff9b::/96: NAT64 to v4
  set_block blocked4 ipv4_addr interval 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 168.63.129.16/32 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3
  set_block blocked6 ipv6_addr interval ::/128 ::1/128 64:ff9b::/96 fc00::/7 fe80::/10 ff00::/8
  set_block dns4 ipv4_addr "" "${dns4[@]}"
  set_block dns6 ipv6_addr "" "${dns6[@]}"
  cat << EOF

	chain output {
		type filter hook output priority filter; policy accept;
		meta skgid $gid jump app_output
	}

	chain app_output {
		ct state established,related accept
		meta l4proto { tcp, udp } th dport 53 ip daddr @dns4 accept
		meta l4proto { tcp, udp } th dport 53 ip6 daddr @dns6 accept
		fib daddr type { local, broadcast, multicast, anycast } reject with icmpx type admin-prohibited
		ip daddr @blocked4 reject with icmpx type admin-prohibited
		ip6 daddr @blocked6 reject with icmpx type admin-prohibited
	}

	chain input {
		type filter hook input priority filter; policy accept;
		iifname != "lo" tcp dport $PORT_MIN-$PORT_MAX drop
	}
}
EOF
)"
printf '%s\n' "$nft_content" | write_if_changed "$NFT_CONF" 0644 root:root || true
write_if_changed "$FW_UNIT" 0644 root:root << EOF && run systemctl daemon-reload || true
# Managed by Workforce OS prepare.sh. Loads the app firewall (table inet wfos_apps) at boot, before the network.
# App units require it: stopping it stops the apps. After nftables.service, whose ruleset may flush everything.
[Unit]
Description=Workforce OS app firewall (nftables table inet wfos_apps)
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target shutdown.target
After=nftables.service
PartOf=nftables.service
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $NFT_CONF
ExecReload=/usr/sbin/nft -f $NFT_CONF
ExecStop=-/usr/sbin/nft delete table inet wfos_apps

[Install]
WantedBy=sysinit.target
EOF
# outside traffic to the app ports is dropped: warn about anything else that listens there on a public address
if [[ "$DRY" == 1 && -n "${WFOS_PREPARE_TEST_LISTEN:-}" ]]; then
  listening="$(cat -- "$WFOS_PREPARE_TEST_LISTEN")"
else
  listening="$(ss -Hltn 2> /dev/null | awk '{ print $4 }' || true)"
fi
while read -r addr; do
  [[ "$addr" =~ ^(.*):([0-9]{1,5})$ ]] || continue
  lport="${BASH_REMATCH[2]}" lhost="${BASH_REMATCH[1]}"
  ((lport >= PORT_MIN && lport <= PORT_MAX)) || continue
  [[ "$lhost" == 127.* || "$lhost" == "[::1]" || "$lhost" == "::1" ]] && continue
  warn "$addr listens on a port of the app range $PORT_MIN-$PORT_MAX: the app firewall drops traffic to it from other hosts"
done <<< "$listening"
run nft -c -f "$NFT_CONF"
run nft -f "$NFT_CONF"
run systemctl enable wfos-apps-firewall.service
run systemctl start wfos-apps-firewall.service

# ---------------------------------------------------------------------------
step "wfos-apps.slice (shared limits of all apps and builds)"
# ---------------------------------------------------------------------------
write_if_changed "$SLICE_UNIT" 0644 root:root << EOF && run systemctl daemon-reload || true
# Managed by Workforce OS prepare.sh. Every app unit and every build runs in this slice: together they never take
# more than 40 % of the memory (throttled from 35 %), two CPUs and 2048 tasks, and they yield disk I/O to the rest.
[Unit]
Description=Workforce OS apps and builds
Before=slices.target

[Slice]
MemoryHigh=35%
MemoryMax=40%
CPUQuota=200%
TasksMax=2048
IOWeight=50
EOF

# ---------------------------------------------------------------------------
step "wfos-app-helper and its sudo rule"
# ---------------------------------------------------------------------------
if [[ "$DRY" == 1 ]]; then
  run install -o root -g root -m 0755 "$HELPER_COPY" "$HELPER_DST"
else
  tmp="$(mktemp /usr/local/sbin/.wfos-tmp.XXXXXX)"
  install -o root -g root -m 0755 "$HELPER_COPY" "$tmp"
  mv -f "$tmp" "$HELPER_DST"
fi
SUDO_LINE="$USER_NAME ALL=(root) NOPASSWD: $HELPER_DST"
if [[ "$DRY" == 1 ]]; then
  printf '%s\n' "# Workforce OS: $USER_NAME may run exactly the app helper as root (written by prepare.sh)" "$SUDO_LINE" | write_file "$SUDOERS" 0440 root:root
  run visudo -cf "$SUDOERS"
else
  # sudo ignores files with a "." in their name, so the temp file is never live; checked before it moves into place
  tmp="$(mktemp /etc/sudoers.d/.wfos-tmp.XXXXXX)"
  printf '%s\n' "# Workforce OS: $USER_NAME may run exactly the app helper as root (written by prepare.sh)" "$SUDO_LINE" > "$tmp"
  chmod 0440 "$tmp"
  if ! visudo -cf "$tmp" > /dev/null; then
    rm -f -- "$tmp"
    fail "visudo rejected the sudoers rule; nothing was changed"
  fi
  mv -f "$tmp" "$SUDOERS"
fi

# the port range of an earlier install is widened in place (helper v4: a second port for each live app)
old_port_max=""
if [[ -f "$OLD_CONF" ]]; then old_port_max="$(sed -nE 's/^PORT_MAX=([0-9]+)$/\1/p' "$OLD_CONF" | head -1)"; fi
if [[ -n "$old_port_max" && "$old_port_max" != "$PORT_MAX" ]]; then
  echo "PORT_MAX moves from $old_port_max to $PORT_MAX (the second port of each live app, for releases without downtime)"
fi
write_file "$CONF" 0644 root:root << EOF
# Written by Workforce OS prepare.sh; read (never sourced) by $HELPER_DST. Re-run prepare.sh to change it.
USER=$USER_NAME
BASE_DOMAIN=$DOMAIN
PG_PORT=$PG_PORT
PG_VERSION=$pg_ver
APPS_ROOT=$APPS_ROOT
PORT_MIN=$PORT_MIN
PORT_MAX=$PORT_MAX
MAX_RUNNING=$MAX_RUNNING
MAX_APPS=$MAX_APPS
EOF

# ---------------------------------------------------------------------------
step "nginx"
# ---------------------------------------------------------------------------
NGX_MAP=/etc/nginx/conf.d/wfos-apps.conf
map_content="# Workforce OS app sites (wfos-app-*): websocket upgrade only when the client asks for it. Written by prepare.sh.
map \$http_upgrade \$wfos_connection_upgrade {
    default upgrade;
    '' close;
}"
# app names like <slug>.preview.<company domain> and live domains (up to 253 characters) are longer than nginx's
# default hash bucket (64) holds ("could not build server_names_hash"): raise it, unless the main config already sets
# it (twice is an error). A name needs about its length + 18 bytes, so 512 holds every valid host name.
hash_elsewhere=0
for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf; do
  [[ "$f" != "$NGX_MAP" && -f "$f" ]] || continue
  if grep -qsE '^[[:space:]]*server_names_hash_bucket_size[[:space:]]' "$f"; then hash_elsewhere=1; fi
done
if ((hash_elsewhere)); then
  warn "server_names_hash_bucket_size is set elsewhere in nginx; make sure it is at least 128 (512 for live domains over 110 characters)"
else
  map_content+="
# long app names (<slug>.<preview domain>, live domains up to 253 characters) need more than the default 64
server_names_hash_bucket_size 512;"
fi
if ! fresh_test && [[ -f "$NGX_MAP" && "$(cat "$NGX_MAP")" == "$map_content" ]]; then
  echo "nginx settings for apps present"
else
  prev=""
  if [[ "$DRY" == 0 && -f "$NGX_MAP" ]]; then
    prev="$(mktemp)"
    cp -p -- "$NGX_MAP" "$prev"
  fi
  printf '%s\n' "$map_content" | write_file "$NGX_MAP" 0644 root:root
  if [[ "$DRY" == 1 ]]; then
    run nginx -t
    run systemctl reload nginx
  elif nginx -t > /dev/null 2>&1; then
    systemctl reload nginx || systemctl start nginx
    [[ -z "$prev" ]] || rm -f -- "$prev"
  else
    if [[ -n "$prev" ]]; then mv -f -- "$prev" "$NGX_MAP"; else rm -f -- "$NGX_MAP"; fi
    fail "nginx -t fails with $NGX_MAP (see: nginx -t); the previous state was restored"
  fi
fi
grep -qs 'sites-enabled' /etc/nginx/nginx.conf || warn "/etc/nginx/nginx.conf does not include sites-enabled/*: app sites would not be served"
# Names under the preview domain that no app owns: 404 over http, TLS handshake refused over https (no wildcard
# certificate needed). Without this nginx would answer them with its default site (often another product on this
# server). Exact app names (wfos-app-<slug>) always win over this wildcard.
CATCHALL=/etc/nginx/sites-available/wfos-apps-catchall
catchall_changed=0
write_if_changed "$CATCHALL" 0644 root:root << EOF && catchall_changed=1
# Managed by Workforce OS prepare.sh: names under $DOMAIN that no app is published at.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN *.$DOMAIN;
    return 404;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN *.$DOMAIN;
    ssl_reject_handshake on;
}
EOF
if ((catchall_changed)) || [[ ! -L /etc/nginx/sites-enabled/wfos-apps-catchall ]] || fresh_test; then
  run ln -sfn "$CATCHALL" /etc/nginx/sites-enabled/wfos-apps-catchall
  if [[ "$DRY" == 1 ]]; then
    run nginx -t
    run systemctl reload nginx
  elif nginx -t > /dev/null 2>&1; then
    systemctl reload nginx
  else
    rm -f /etc/nginx/sites-enabled/wfos-apps-catchall "$CATCHALL"
    fail "nginx -t fails with the catch-all site for $DOMAIN (see: nginx -t); it was removed again"
  fi
fi
# An app can set cookies for its parent domains (up to the registrable one): when another site on this server sits
# under the same registrable domain, apps can toss cookies at it. Approximation of the registrable domain without
# the public suffix list: the last two labels, or three when the second-to-last is a short second level (co.id).
reg="$(awk -F. '{ n = NF; if (n >= 3 && length($(n - 1)) <= 3 && length($n) == 2) print $(n - 2) "." $(n - 1) "." $n; else print $(n - 1) "." $n }' <<< "$DOMAIN")"
shared="$(nginx -T 2> /dev/null | grep -oE '^[[:space:]]*server_name[^;]*' | sed -E 's/^[[:space:]]*server_name//' | tr ' \t' '\n\n' | tr 'A-Z' 'a-z' |
  grep -E "(^|\.)${reg//./\\.}\$" | grep -vE "(^|\.)${DOMAIN//./\\.}\$" | sort -u | head -5 | tr '\n' ' ' || true)"
if [[ -n "$shared" ]]; then
  warn "!!! the preview domain $DOMAIN shares the registrable domain $reg with other sites on this server: $shared"
  warn "!!! apps could set cookies for those sites (cookie tossing). Use a dedicated domain for previews (see README)."
fi

# ---------------------------------------------------------------------------
step "ufw"
# ---------------------------------------------------------------------------
if command -v ufw > /dev/null && ufw status 2> /dev/null | grep -q '^Status: active'; then
  run ufw allow 80/tcp
  run ufw allow 443/tcp
else
  echo "ufw not active: make sure ports 80 and 443 reach this server"
fi

# ---------------------------------------------------------------------------
step "checks"
# ---------------------------------------------------------------------------
sd="$(systemctl --version 2> /dev/null | awk 'NR == 1 { print $2 }')"
if [[ ! "$sd" =~ ^[0-9]+$ ]] || ((sd < 254)); then
  warn "systemd ${sd:-unknown} is old: the app sandbox needs systemd 254 or later"
elif ((sd < 257)); then
  echo "systemd $sd: apps run without PrivatePIDs= (needs 257)"
fi
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || warn "cgroup v2 is not mounted: app memory limits will not apply"
if [[ "$DRY" == 0 ]]; then
  nft list table inet wfos_apps > /dev/null 2>&1 || fail "the app firewall is not loaded (nft list table inet wfos_apps)"
  got="$(cd / && runuser -u "$USER_NAME" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME_DIR" COREPACK_HOME="$COREPACK_DIR" \
    COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm -v 2> /dev/null | head -1 || true)"
  [[ "$got" == "$PNPM_VERSION" ]] || warn "pnpm -v as $USER_NAME prints ${got:-nothing}, expected $PNPM_VERSION"
fi
echo "DNS: *.$DOMAIN must point at this server (previews are served at <slug>.$DOMAIN; a live domain and its aliases need their own A/AAAA records)"

echo
echo "SSH host key of this server (compare with the fingerprint Workforce OS shows before you confirm):"
if [[ -f /etc/ssh/ssh_host_ed25519_key.pub ]]; then
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
else
  warn "/etc/ssh/ssh_host_ed25519_key.pub is missing; Workforce OS will show another host key type"
  for f in /etc/ssh/ssh_host_*_key.pub; do [[ -f "$f" ]] && ssh-keygen -lf "$f"; done
fi
echo
if [[ "$DRY" == 1 ]]; then
  echo "DRY RUN finished: nothing was changed"
else
  echo "WFOS_SERVER_READY"
fi
