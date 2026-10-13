#!/bin/bash
# ###################################################################################################################
# NOT INSTALLED — draft for A2, has known security issues listed in docs; do not use.
#
# This is the Phase A1 helper's former run/build/publish/db code (unit-*, build-run, publish, unpublish, db-create,
# db-dump), kept only so Phase A2 can reuse its argument validation. prepare.sh never installs it, the web app never
# serves it, and the two lines right below this header stop it from doing anything if someone runs it anyway.
# Known issues to fix in A2 (A1 security review): root reads user-controlled paths (EnvironmentFile under
# APPS_ROOT), all apps share one runtime user, apps can reach host loopback/private services (Postgres, Redis, the
# web app), no disk guard, publish may take another site's server_name, db-create resets existing role passwords,
# no REVOKE CONNECT on postgres/template1. The lock file belongs at /run/wfos-app-helper.lock.
# ###################################################################################################################
echo "helper-a2-draft.sh: draft only, not for use" >&2
exit 1

# wfos-app-helper — the only way Workforce OS gets root on an app server.
#
# Installed by prepare.sh as /usr/local/sbin/wfos-app-helper (root:root 0755). The apps user (default wfos-apps) may
# run exactly this file with `sudo -n`, nothing else. Every argument is validated here; anything unexpected exits 2
# with a one-line error and changes nothing. Settings come from /etc/wfos-app-helper.conf (written by prepare.sh,
# never sourced: only known KEY=value lines are read and validated).
#
#   version                                   helper version (one number)
#   info                                      one JSON line: versions, disk, memory, base domain
#   unit-install <slug> <port> <memMB>        systemd unit wfos-app-<slug>.service (sandboxed, runs as the apps user)
#   unit-start|unit-stop|unit-restart <slug>  start (and enable at boot) / stop (and disable) / restart
#   unit-status <slug>                        one JSON line with the unit's state
#   unit-remove <slug>                        stop, disable and delete the unit
#   build-run <slug> <timeoutSec> <memMB> -- <script>
#                                             run <apps root>/<slug>/<script> with bash as a sandboxed transient unit
#   publish <slug> <port> [--auth]            nginx site + Let's Encrypt certificate for <slug>.<base domain>;
#                                             --auth reads one htpasswd line (apr1 or bcrypt) on stdin
#   unpublish <slug>                          remove the nginx site (the certificate is kept for a later publish)
#   db-create <slug>                          role + database app_<slug> on the apps Postgres cluster (password on stdin)
#   db-dump <slug>                            pg_dump (custom format) of that database to stdout
#
# WFOS_HELPER_DRY_RUN=1 prints every command and file it would run or write and changes nothing; only then may
# WFOS_HELPER_CONF point at another config file (sudo drops both variables, so they cannot reach a real run).
set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

HELPER_VERSION=1
RESERVED_SLUGS=" www api app apps admin mail preview static assets cdn status "

usage() { echo "wfos-app-helper: $*" >&2; exit 2; }
fail() { echo "wfos-app-helper: $*" >&2; exit 1; }

DRY=0
CONF=/etc/wfos-app-helper.conf
if [[ "${WFOS_HELPER_DRY_RUN:-}" == 1 ]]; then
  DRY=1
  CONF="${WFOS_HELPER_CONF:-$CONF}"
fi
[[ "$DRY" == 1 || "$(id -u)" == 0 ]] || fail "must run as root (sudo -n $0 ...)"

# ---------------------------------------------------------------------------
# dry-run aware actions
# ---------------------------------------------------------------------------

# run CMD ARGS...: execute, or print it in dry-run
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

# serialise changes (two publishes at once would race on nginx)
lock() {
  [[ "$DRY" == 1 ]] && return 0
  exec 9> /run/lock/wfos-app-helper.lock
  flock -w 300 9 || fail "another wfos-app-helper call is still running"
}

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

C_USER="" C_BASE_DOMAIN="" C_PG_PORT="" C_APPS_ROOT="" C_PORT_MIN="" C_PORT_MAX=""
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

is_uint() { [[ "$1" =~ ^[1-9][0-9]{0,5}$ ]]; }

read_conf() {
  [[ -f "$CONF" ]] || fail "missing $CONF (run prepare.sh)"
  if [[ "$DRY" == 0 ]]; then
    # root-owned and not writable by anyone else, or it could steer the helper
    [[ "$(stat -c '%u' "$CONF")" == 0 && $(( 8#$(stat -c '%a' "$CONF") & 8#022 )) == 0 ]] || fail "$CONF must be owned by root and not group/world writable"
  fi
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || fail "bad line in $CONF"
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    case "$key" in
      USER) C_USER="$val" ;;
      BASE_DOMAIN) C_BASE_DOMAIN="$val" ;;
      PG_PORT) C_PG_PORT="$val" ;;
      APPS_ROOT) C_APPS_ROOT="$val" ;;
      PORT_MIN) C_PORT_MIN="$val" ;;
      PORT_MAX) C_PORT_MAX="$val" ;;
      *) ;; # unknown keys are ignored (newer prepare.sh)
    esac
  done < "$CONF"
  [[ "$C_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$C_USER" != root ]] || fail "$CONF: bad USER"
  [[ ${#C_BASE_DOMAIN} -le 200 && "$C_BASE_DOMAIN" =~ $DOMAIN_RE ]] || fail "$CONF: bad BASE_DOMAIN"
  [[ "$C_APPS_ROOT" =~ ^/[A-Za-z0-9._/-]+$ && ! "$C_APPS_ROOT" =~ (^|/)\.\.?(/|$) && "$C_APPS_ROOT" != */ ]] || fail "$CONF: bad APPS_ROOT"
  is_uint "$C_PG_PORT" && (( C_PG_PORT >= 1024 && C_PG_PORT <= 65535 )) || fail "$CONF: bad PG_PORT"
  is_uint "$C_PORT_MIN" && is_uint "$C_PORT_MAX" && (( C_PORT_MIN >= 1024 && C_PORT_MIN <= C_PORT_MAX && C_PORT_MAX <= 65535 )) || fail "$CONF: bad PORT_MIN/PORT_MAX"
}

# ---------------------------------------------------------------------------
# argument validation (exit 2 on anything unexpected)
# ---------------------------------------------------------------------------

check_slug() {
  local s="${1:-}"
  [[ "$s" =~ ^[a-z][a-z0-9-]{1,29}$ && "$s" != *- ]] || usage "invalid slug ${s@Q} (a-z, 0-9, -; 2 to 30 characters; starts with a letter)"
  [[ "$RESERVED_SLUGS" != *" $s "* ]] || usage "slug ${s@Q} is reserved"
}

check_port() {
  local p="${1:-}"
  is_uint "$p" && (( p >= C_PORT_MIN && p <= C_PORT_MAX )) || usage "invalid port ${p@Q} (allowed $C_PORT_MIN..$C_PORT_MAX)"
}

check_mem() {
  local m="${1:-}"
  is_uint "$m" && (( m >= 128 && m <= 4096 )) || usage "invalid memory ${m@Q} MB (allowed 128..4096)"
}

check_timeout() {
  local t="${1:-}"
  is_uint "$t" && (( t >= 30 && t <= 7200 )) || usage "invalid timeout ${t@Q} s (allowed 30..7200)"
}

# a relative path to a file inside the app directory: no absolute path, no "..", no symlink pointing outside
check_script() {
  local slug="$1" rel="${2:-}" base real
  [[ -n "$rel" && ${#rel} -le 200 && "$rel" =~ ^[A-Za-z0-9._/-]+$ ]] || usage "invalid script path ${rel@Q}"
  [[ "$rel" != /* && ! "$rel" =~ (^|/)\.\.(/|$) && "$rel" != */ ]] || usage "script path must stay inside the app directory"
  base="$(realpath -m -- "$C_APPS_ROOT/$slug")"
  real="$(realpath -m -- "$base/$rel")"
  [[ "$real" == "$base/"* ]] || usage "script path must stay inside the app directory"
  if [[ "$DRY" == 0 ]]; then
    [[ -f "$real" ]] || fail "script $rel does not exist"
  fi
  SCRIPT_REAL="$real"
}

app_dir() { echo "$C_APPS_ROOT/$1"; }
unit_name() { echo "wfos-app-$1.service"; }
unit_path() { echo "/etc/systemd/system/wfos-app-$1.service"; }
db_name() { echo "app_${1//-/_}"; }

# paths every app sandbox must never see
INACCESSIBLE="-/root -/run/redis -/var/run/redis -/etc/letsencrypt -/etc/wfos-app-helper.conf -/etc/nginx/wfos-apps"

# ---------------------------------------------------------------------------
# info
# ---------------------------------------------------------------------------

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="$(printf '%s' "$s" | tr -d '\000-\037')"
  printf '"%s"' "$s"
}

# a command as the apps user (HOME = its home), output trimmed to one line; empty when it fails
as_user_line() {
  local home out
  if id -u "$C_USER" > /dev/null 2>&1; then
    home="$(getent passwd "$C_USER" | cut -d: -f6)"
    out="$(cd / && timeout 20 runuser -u "$C_USER" -- env HOME="$home" PATH="$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@" 2> /dev/null | head -1)" || out=""
  elif [[ "$DRY" == 1 ]]; then
    out="$(cd / && timeout 20 env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_NETWORK=0 "$@" 2> /dev/null | head -1)" || out=""
  else
    out=""
  fi
  printf '%s' "$out"
}

cmd_info() {
  local os node pnpm nginx=false certbot=false pg=null disk=0 mem_total=0 mem_avail=0 dir
  os="$(sed -nE 's/^PRETTY_NAME="?([^"]*)"?$/\1/p' /etc/os-release 2> /dev/null | head -1)"
  node="$(command -v node > /dev/null && as_user_line node -v || true)"
  pnpm="$(command -v pnpm > /dev/null && as_user_line pnpm -v || true)"
  command -v nginx > /dev/null && nginx=true
  command -v certbot > /dev/null && certbot=true
  if command -v pg_lsclusters > /dev/null && pg_lsclusters --no-header 2> /dev/null | awk -v p="$C_PG_PORT" '$2 == "apps" && $3 == p && $4 ~ /^online/ { found = 1 } END { exit !found }'; then
    pg="$C_PG_PORT"
  fi
  dir="$C_APPS_ROOT"
  while [[ ! -d "$dir" && "$dir" != / ]]; do dir="$(dirname "$dir")"; done
  disk="$(df -Pm -- "$dir" 2> /dev/null | awk 'NR == 2 { print $4 + 0 }')"
  mem_total="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  mem_avail="$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  printf '{"helperVersion":%d,"os":%s,"node":%s,"pnpm":%s,"nginx":%s,"certbot":%s,"postgresPort":%s,"diskFreeMb":%d,"memTotalMb":%d,"memAvailableMb":%d,"baseDomain":%s}\n' \
    "$HELPER_VERSION" "$(json_str "$os")" "$(json_str "$node")" "$(json_str "$pnpm")" "$nginx" "$certbot" "$pg" \
    "${disk:-0}" "${mem_total:-0}" "${mem_avail:-0}" "$(json_str "$C_BASE_DOMAIN")"
}

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------

cmd_unit_install() {
  local slug="$1" port="$2" mem="$3" dir
  dir="$(app_dir "$slug")"
  lock
  write_file "$(unit_path "$slug")" 0644 root:root << EOF
# Managed by wfos-app-helper (Workforce OS): rewritten by unit-install, do not edit.
[Unit]
Description=Workforce OS app $slug (port $port)
After=network.target

[Service]
Type=simple
User=$C_USER
Group=$C_USER
WorkingDirectory=$dir/current
EnvironmentFile=$dir/app.env
Environment=HOME=$dir
ExecStart=$dir/current/.wfos-start
Restart=on-failure
RestartSec=5
UMask=0027
MemoryMax=${mem}M
MemorySwapMax=0
CPUQuota=100%
TasksMax=256
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=tmpfs
BindPaths=$dir
ReadWritePaths=$dir
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
InaccessiblePaths=$INACCESSIBLE

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
}

require_unit() {
  [[ "$DRY" == 1 || -f "$(unit_path "$1")" ]] || fail "app $1 has no unit (unit-install first)"
}

cmd_unit_action() {
  local action="$1" slug="$2" unit
  unit="$(unit_name "$slug")"
  require_unit "$slug"
  lock
  case "$action" in
    unit-start) run systemctl enable --now "$unit" ;;
    unit-stop) run systemctl disable --now "$unit" ;;
    unit-restart) run systemctl restart "$unit" ;;
  esac
}

cmd_unit_status() {
  local slug="$1" unit load active sub restarts mem
  unit="$(unit_name "$slug")"
  if [[ "$DRY" == 1 ]]; then
    run systemctl show "$unit" -p LoadState -p ActiveState -p SubState -p NRestarts -p MemoryCurrent
    return 0
  fi
  load="$(systemctl show "$unit" -p LoadState --value 2> /dev/null || echo unknown)"
  active="$(systemctl show "$unit" -p ActiveState --value 2> /dev/null || echo unknown)"
  sub="$(systemctl show "$unit" -p SubState --value 2> /dev/null || echo unknown)"
  restarts="$(systemctl show "$unit" -p NRestarts --value 2> /dev/null || echo 0)"
  mem="$(systemctl show "$unit" -p MemoryCurrent --value 2> /dev/null || echo 0)"
  [[ "$restarts" =~ ^[0-9]+$ ]] || restarts=0
  [[ "$mem" =~ ^[0-9]+$ ]] || mem=0
  printf '{"loadState":%s,"activeState":%s,"subState":%s,"restarts":%d,"memoryBytes":%d}\n' \
    "$(json_str "$load")" "$(json_str "$active")" "$(json_str "$sub")" "$restarts" "$mem"
}

cmd_unit_remove() {
  local slug="$1" unit path
  unit="$(unit_name "$slug")"
  path="$(unit_path "$slug")"
  lock
  if [[ "$DRY" == 1 || -f "$path" ]]; then
    run systemctl disable --now "$unit"
    run rm -f -- "$path"
    run systemctl daemon-reload
  fi
}

cmd_build_run() {
  local slug="$1" timeout="$2" mem="$3" script="$4" dir
  dir="$(app_dir "$slug")"
  check_script "$slug" "$script"
  # one build per app at a time: the fixed unit name makes a second one fail to start
  run systemd-run --wait --pipe --collect --quiet \
    --unit="wfos-build-$slug" \
    --uid="$C_USER" --gid="$C_USER" \
    -p "MemoryMax=${mem}M" -p MemorySwapMax=0 -p "RuntimeMaxSec=$timeout" -p CPUQuota=200% -p TasksMax=512 \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p "BindPaths=$dir" -p "ReadWritePaths=$dir" \
    -p PrivateTmp=yes -p PrivateDevices=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes \
    -p RestrictSUIDSGID=yes -p "InaccessiblePaths=$INACCESSIBLE" \
    -p "WorkingDirectory=$dir" -p "Environment=HOME=$dir" -p "Environment=CI=1" -p "Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0" \
    /bin/bash "$SCRIPT_REAL"
}

# ---------------------------------------------------------------------------
# nginx + certificates
# ---------------------------------------------------------------------------

NGINX_SITES=/etc/nginx/sites-available
NGINX_ENABLED=/etc/nginx/sites-enabled
NGINX_AUTH_DIR=/etc/nginx/wfos-apps
# one user, an apr1 (MD5) or bcrypt hash: never a plain password
HTPASSWD_RE='^[a-z0-9_-]{1,64}:\$(apr1|2y)\$[A-Za-z0-9./$]{20,200}$'

# "http2 on;" from nginx 1.25.1, "listen ... http2" before
nginx_http2_directive() {
  local v
  v="$(nginx -v 2>&1 | sed -nE 's|.*nginx/([0-9]+)\.([0-9]+)\.([0-9]+).*|\1 \2 \3|p')"
  if [[ -z "$v" ]]; then
    echo modern
    return 0
  fi
  read -r ma mi pa <<< "$v"
  if (( ma > 1 || (ma == 1 && (mi > 25 || (mi == 25 && pa >= 1))) )); then echo modern; else echo legacy; fi
}

# site_content SLUG PORT AUTH(0|1) MODE(http|full)
site_content() {
  local slug="$1" port="$2" auth="$3" mode="$4" domain h2 listen443 listen443v6 http2_line=""
  domain="$slug.$C_BASE_DOMAIN"
  h2="$(nginx_http2_directive)"
  if [[ "$h2" == modern ]]; then
    listen443="listen 443 ssl;"
    listen443v6="listen [::]:443 ssl;"
    http2_line="    http2 on;"
  else
    listen443="listen 443 ssl http2;"
    listen443v6="listen [::]:443 ssl http2;"
  fi
  cat << EOF
# Managed by wfos-app-helper (Workforce OS): rewritten by publish, removed by unpublish. Do not edit.
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
EOF
  if [[ "$mode" == http ]]; then
    # before the certificate exists: only what certbot needs
    cat << 'EOF'
    location / {
        return 404;
    }
}
EOF
    return 0
  fi
  cat << EOF
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    $listen443
    $listen443v6
$http2_line
    server_name $domain;

    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:wfos_apps_ssl:10m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    client_max_body_size 25m;
EOF
  if [[ "$auth" == 1 ]]; then
    cat << EOF

    auth_basic "Preview";
    auth_basic_user_file $NGINX_AUTH_DIR/$slug.htpasswd;
EOF
  fi
  cat << EOF

    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$wfos_connection_upgrade;
        proxy_read_timeout 300s;
    }
}
EOF
}

# nginx -t, then reload; on failure put the previous site back (or remove the new one) and fail
nginx_apply() {
  local site="$1" enabled="$2" backup="$3"
  if [[ "$DRY" == 1 ]]; then
    run nginx -t
    run systemctl reload nginx
    return 0
  fi
  if nginx -t > /dev/null 2>&1; then
    systemctl reload nginx
    return 0
  fi
  if [[ -n "$backup" && -f "$backup" ]]; then
    mv -f "$backup" "$site"
  else
    rm -f -- "$site" "$enabled"
  fi
  nginx -t > /dev/null 2>&1 && systemctl reload nginx || true
  fail "nginx rejected the configuration for $(basename "$site"); the previous configuration was restored"
}

cmd_publish() {
  local slug="$1" port="$2" auth="$3" domain site enabled htpasswd line="" backup="" cert
  domain="$slug.$C_BASE_DOMAIN"
  site="$NGINX_SITES/wfos-app-$slug"
  enabled="$NGINX_ENABLED/wfos-app-$slug"
  htpasswd="$NGINX_AUTH_DIR/$slug.htpasswd"
  cert="/etc/letsencrypt/live/$domain/fullchain.pem"
  if [[ "$auth" == 1 ]]; then
    IFS= read -r -n 512 line || true
    [[ "$line" =~ $HTPASSWD_RE ]] || usage "--auth needs one htpasswd line (user:\$apr1\$… or user:\$2y\$…) on stdin"
  fi
  lock
  if [[ "$DRY" == 0 ]]; then
    [[ -d "$NGINX_AUTH_DIR" ]] || fail "$NGINX_AUTH_DIR is missing (run prepare.sh)"
    if [[ -f "$site" ]]; then
      backup="$(mktemp "$NGINX_SITES/.wfos-backup.XXXXXX")"
      cp -p -- "$site" "$backup"
    fi
  fi
  if [[ "$auth" == 1 ]]; then
    printf '%s\n' "$line" | write_file "$htpasswd" 0640 root:www-data
  else
    run rm -f -- "$htpasswd"
  fi
  # 1) no certificate yet: an HTTP-only site so certbot's nginx authenticator can answer the challenge
  if [[ "$DRY" == 1 || ! -f "$cert" ]]; then
    [[ "$DRY" == 1 ]] && echo "[dry-run] (only when $cert does not exist yet)"
    site_content "$slug" "$port" "$auth" http | write_file "$site" 0644 root:root
    run ln -sfn "$site" "$enabled"
    nginx_apply "$site" "$enabled" "$backup"
    run certbot certonly --nginx -d "$domain" --keep-until-expiring --non-interactive --agree-tos --register-unsafely-without-email
    if [[ "$DRY" == 0 && ! -f "$cert" ]]; then
      [[ -n "$backup" ]] && mv -f "$backup" "$site" || rm -f -- "$site" "$enabled"
      nginx -t > /dev/null 2>&1 && systemctl reload nginx || true
      fail "no certificate for $domain (does DNS for $domain point at this server?)"
    fi
  fi
  # 2) the real site
  site_content "$slug" "$port" "$auth" full | write_file "$site" 0644 root:root
  run ln -sfn "$site" "$enabled"
  nginx_apply "$site" "$enabled" "$backup"
  [[ -n "$backup" ]] && rm -f -- "$backup"
  echo "published https://$domain"
}

cmd_unpublish() {
  local slug="$1" site enabled
  site="$NGINX_SITES/wfos-app-$slug"
  enabled="$NGINX_ENABLED/wfos-app-$slug"
  lock
  run rm -f -- "$enabled" "$site" "$NGINX_AUTH_DIR/$slug.htpasswd"
  if [[ "$DRY" == 1 ]] || nginx -t > /dev/null 2>&1; then
    run systemctl reload nginx
  else
    fail "nginx -t fails after removing the site; check the nginx configuration"
  fi
}

# ---------------------------------------------------------------------------
# Postgres (the apps-only cluster)
# ---------------------------------------------------------------------------

psql_apps() {
  run runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$C_PG_PORT" -d postgres "$@"
}

cmd_db_create() {
  local slug="$1" name pw=""
  name="$(db_name "$slug")"
  IFS= read -r -n 100 pw || true
  [[ "$pw" =~ ^[0-9a-f]{32,64}$ ]] || usage "db-create needs the password on stdin (32 to 64 lowercase hex characters)"
  lock
  # the password goes in on stdin, never on a command line (other users can read those); every value is validated
  # above ([a-z0-9_] names, hex password), and quoted again by psql (:'v' / :"v")
  if [[ "$DRY" == 1 ]]; then
    psql_apps < /dev/null
    echo "[dry-run] stdin: create role/database $name if missing, set its password, REVOKE CONNECT FROM PUBLIC, GRANT CONNECT TO $name"
    return 0
  fi
  psql_apps << EOF
\\set name '$name'
\\set pw '$pw'
SELECT format('CREATE ROLE %I LOGIN', :'name') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'name') \\gexec
ALTER ROLE :"name" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'name') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'name') \\gexec
REVOKE CONNECT, TEMPORARY ON DATABASE :"name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"name" TO :"name";
EOF
  echo "database $name ready"
}

cmd_db_dump() {
  local slug="$1" name
  name="$(db_name "$slug")"
  if [[ "$DRY" == 0 ]]; then
    runuser -u postgres -- psql -X -tA -p "$C_PG_PORT" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$name'" | grep -q 1 || fail "database $name does not exist"
  fi
  run runuser -u postgres -- pg_dump -p "$C_PG_PORT" -Fc -- "$name"
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
nargs() { [[ "$1" == "$2" ]] || usage "$cmd: wrong number of arguments"; }

case "$cmd" in
  version)
    nargs $# 0
    echo "$HELPER_VERSION"
    ;;
  info)
    nargs $# 0
    read_conf
    cmd_info
    ;;
  unit-install)
    nargs $# 3
    read_conf
    check_slug "$1"
    check_port "$2"
    check_mem "$3"
    cmd_unit_install "$1" "$2" "$3"
    ;;
  unit-start | unit-stop | unit-restart)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_unit_action "$cmd" "$1"
    ;;
  unit-status)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_unit_status "$1"
    ;;
  unit-remove)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_unit_remove "$1"
    ;;
  build-run)
    nargs $# 5
    read_conf
    check_slug "$1"
    check_timeout "$2"
    check_mem "$3"
    [[ "$4" == -- ]] || usage "build-run: expected -- before the script path"
    cmd_build_run "$1" "$2" "$3" "$5"
    ;;
  publish)
    [[ $# -eq 2 || ($# -eq 3 && "${3:-}" == --auth) ]] || usage "publish <slug> <port> [--auth]"
    read_conf
    check_slug "$1"
    check_port "$2"
    cmd_publish "$1" "$2" "$([[ $# -eq 3 ]] && echo 1 || echo 0)"
    ;;
  unpublish)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_unpublish "$1"
    ;;
  db-create)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_db_create "$1"
    ;;
  db-dump)
    nargs $# 1
    read_conf
    check_slug "$1"
    cmd_db_dump "$1"
    ;;
  "")
    usage "missing command (version, info, unit-install, unit-start, unit-stop, unit-restart, unit-status, unit-remove, build-run, publish, unpublish, db-create, db-dump)"
    ;;
  *)
    usage "unknown command ${cmd@Q}"
    ;;
esac
