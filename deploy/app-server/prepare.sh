#!/usr/bin/env bash
# Workforce OS — prepare a server to run the apps a workspace's employees build (App factory, Phase A).
# Run it yourself as root on that server, with wfos-app-helper next to it (copy both files). Idempotent: re-run it
# safely, e.g. to update the helper or after changing the domain.
#
#   sudo bash prepare.sh --public-key "ssh-ed25519 AAAA… wfos-<workspace>" --domain preview.example.com \
#     [--user wfos-apps] [--pg-port 5433] [--node-major 24] [--dry-run]
#
# What it does (each step skips what is already in place):
#   - apt: nginx, certbot (+ nginx plugin), PostgreSQL, jq, git, rsync, build-essential
#   - Node.js <node-major> from NodeSource, only when node is missing or another major; pnpm via corepack
#   - a system user (default wfos-apps) without sudo rights, its ~/apps folder, and the workspace's public key in its
#     authorized_keys (no agent / port / X11 forwarding, no pty)
#   - a separate PostgreSQL cluster "apps" on <pg-port> (localhost only, small memory) for the apps' databases
#   - /usr/local/sbin/wfos-app-helper (root:root 0755) + a sudoers rule that lets the user run exactly that file
#   - /etc/wfos-app-helper.conf, the nginx include folder /etc/nginx/wfos-apps and a websocket map
#   - ufw: allow 80 and 443 when ufw is active
# At the end it prints this server's SSH host key fingerprint (compare it with the one Workforce OS shows before you
# confirm) and WFOS_SERVER_READY. Workforce OS never sees a root password: everything root does later goes through
# the helper, which validates every argument.
#
# --dry-run prints every action instead of doing it (no changes at all; does not need root).
set -euo pipefail
export LC_ALL=C

USER_NAME=wfos-apps PG_PORT=5433 NODE_MAJOR=24 DOMAIN="" PUBLIC_KEY="" DRY=0
HELPER_DST=/usr/local/sbin/wfos-app-helper
SUDOERS=/etc/sudoers.d/wfos-app-helper
CONF=/etc/wfos-app-helper.conf
PORT_MIN=4100 PORT_MAX=4499
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
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
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
[[ "$PG_PORT" =~ ^[1-9][0-9]{3,4}$ ]] && (( PG_PORT >= 1024 && PG_PORT <= 65535 && PG_PORT != 5432 )) || die "--pg-port must be 1024..65535 and not 5432"
[[ "$NODE_MAJOR" =~ ^[1-9][0-9]$ ]] && (( NODE_MAJOR >= 20 )) || die "--node-major must be a Node.js major version (20 or later)"
[[ -f "$HELPER_SRC" ]] || fail "wfos-app-helper must be next to prepare.sh ($HELPER_SRC)"
bash -n "$HELPER_SRC" || fail "$HELPER_SRC has a syntax error"
[[ "$DRY" == 1 || "$(id -u)" == 0 ]] || fail "run as root (sudo bash prepare.sh …), or try --dry-run"

if [[ -r /etc/os-release ]]; then
  OS_ID="$(sed -nE 's/^ID="?([^"]*)"?$/\1/p' /etc/os-release | head -1)"
  OS_LIKE="$(sed -nE 's/^ID_LIKE="?([^"]*)"?$/\1/p' /etc/os-release | head -1)"
else
  OS_ID="" OS_LIKE=""
fi
[[ "$OS_ID" == ubuntu || "$OS_ID" == debian || " $OS_LIKE " == *" debian "* ]] || fail "only Ubuntu and Debian are supported (found ${OS_ID:-unknown})"

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

# write_file PATH MODE OWNER:GROUP < content — atomic (temp file in the same directory, then mv)
write_file() {
  local path="$1" mode="$2" owner="$3" tmp
  if [[ "$DRY" == 1 ]]; then
    echo "[dry-run] write $path (mode $mode, owner $owner)"
    sed 's/^/  | /'
    echo "[dry-run] end $path"
    return 0
  fi
  tmp="$(mktemp "$(dirname "$path")/.wfos-tmp.XXXXXX")"
  cat > "$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
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
step "Node.js $NODE_MAJOR and pnpm"
# ---------------------------------------------------------------------------
current_major=""
command -v node > /dev/null && current_major="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || true)"
if [[ "$current_major" != "$NODE_MAJOR" ]]; then
  [[ -n "$current_major" ]] && warn "node $current_major is installed; replacing it with $NODE_MAJOR (NodeSource)"
  if [[ "$DRY" == 1 ]]; then
    run curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
    run bash /tmp/nodesource_setup.sh
  else
    ns="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$ns"
    bash "$ns"
    rm -f -- "$ns"
  fi
  run apt-get install -y nodejs
else
  echo "node $(node -v) present"
fi
if command -v pnpm > /dev/null; then
  echo "pnpm present"
else
  run corepack enable
fi

# ---------------------------------------------------------------------------
step "user $USER_NAME"
# ---------------------------------------------------------------------------
if id -u "$USER_NAME" > /dev/null 2>&1; then
  echo "exists"
  for g in $(id -nG "$USER_NAME"); do
    [[ "$g" == sudo || "$g" == admin || "$g" == wheel || "$g" == root ]] && fail "user $USER_NAME is in group $g; it must not have sudo rights beyond the helper"
  done
  HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
else
  run useradd --create-home --shell /bin/bash --user-group "$USER_NAME"
  HOME_DIR="/home/$USER_NAME"
fi
[[ "$HOME_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$HOME_DIR" != / ]] || fail "unexpected home directory ${HOME_DIR@Q} for $USER_NAME"
APPS_ROOT="$HOME_DIR/apps"
run install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR"
run install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
run install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$APPS_ROOT"

# authorized_keys: our line replaces an older line with the same key; other keys stay
KEY_BLOB="$(cut -d' ' -f2 <<< "$PUBLIC_KEY")"
KEY_LINE="no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty $PUBLIC_KEY"
AUTH_KEYS="$HOME_DIR/.ssh/authorized_keys"
{
  if [[ -f "$AUTH_KEYS" ]]; then
    grep -vF -- " $KEY_BLOB" "$AUTH_KEYS" || true
  fi
  printf '%s\n' "$KEY_LINE"
} | write_file "$AUTH_KEYS" 0600 "$USER_NAME:$USER_NAME"

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
step "PostgreSQL cluster \"apps\" on port $PG_PORT"
# ---------------------------------------------------------------------------
if command -v pg_lsclusters > /dev/null; then
  existing="$(pg_lsclusters --no-header 2> /dev/null | awk '$2 == "apps" { print $1 " " $3 }' | head -1)"
  taken="$(pg_lsclusters --no-header 2> /dev/null | awk -v p="$PG_PORT" '$3 == p && $2 != "apps" { print $1 "/" $2 }' | head -1)"
else
  existing="" taken=""
fi
if [[ -n "$existing" ]]; then
  read -r pg_ver pg_port_now <<< "$existing"
  echo "exists ($pg_ver/apps on port $pg_port_now)"
  [[ "$pg_port_now" == "$PG_PORT" ]] || warn "cluster apps listens on $pg_port_now, not $PG_PORT; the helper uses $PG_PORT"
  run pg_ctlcluster "$pg_ver" apps start || true
else
  [[ -z "$taken" ]] || fail "port $PG_PORT is already used by PostgreSQL cluster $taken; choose another --pg-port"
  pg_ver="$(ls /usr/lib/postgresql 2> /dev/null | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
  if [[ -z "$pg_ver" ]]; then
    [[ "$DRY" == 1 ]] || fail "no PostgreSQL server found under /usr/lib/postgresql"
    pg_ver="<version>"
  fi
  run pg_createcluster "$pg_ver" apps --port "$PG_PORT" --start \
    -o listen_addresses=localhost -o shared_buffers=64MB -o max_connections=50
fi

# ---------------------------------------------------------------------------
step "wfos-app-helper and its sudo rule"
# ---------------------------------------------------------------------------
if [[ "$DRY" == 1 ]]; then
  run install -o root -g root -m 0755 "$HELPER_SRC" "$HELPER_DST"
else
  tmp="$(mktemp /usr/local/sbin/.wfos-tmp.XXXXXX)"
  install -o root -g root -m 0755 "$HELPER_SRC" "$tmp"
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

write_file "$CONF" 0644 root:root << EOF
# Written by Workforce OS prepare.sh; read (never sourced) by $HELPER_DST. Re-run prepare.sh to change it.
USER=$USER_NAME
BASE_DOMAIN=$DOMAIN
PG_PORT=$PG_PORT
APPS_ROOT=$APPS_ROOT
PORT_MIN=$PORT_MIN
PORT_MAX=$PORT_MAX
EOF

# ---------------------------------------------------------------------------
step "nginx"
# ---------------------------------------------------------------------------
run install -d -m 0750 -o root -g www-data /etc/nginx/wfos-apps
NGX_MAP=/etc/nginx/conf.d/wfos-apps.conf
map_content="# Workforce OS app sites (wfos-app-*): websocket upgrade only when the client asks for it. Written by prepare.sh.
map \$http_upgrade \$wfos_connection_upgrade {
    default upgrade;
    '' close;
}"
if [[ -f "$NGX_MAP" && "$(cat "$NGX_MAP")" == "$map_content" ]]; then
  echo "websocket map present"
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

# ---------------------------------------------------------------------------
step "firewall"
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
[[ "$sd" =~ ^[0-9]+$ && "$sd" -ge 247 ]] || warn "systemd ${sd:-unknown} is old: the app sandbox needs systemd 247 or later"
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || warn "cgroup v2 is not mounted: app memory limits will not apply"
echo "DNS: *.$DOMAIN must point at this server (apps are served at <slug>.$DOMAIN)"

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
