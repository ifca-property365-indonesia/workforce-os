#!/usr/bin/env bash
# Workforce OS — idempotent setup for a fresh Ubuntu 24.04 or 26.04 server (run as root from the checkout; re-run safely).
#
#   deploy/setup-ubuntu.sh [--domain ai.example.com --email you@example.com] [--no-firewall]
#   deploy/setup-ubuntu.sh --toolchain        only the Workspace-mode toolchain
#
# What it does (each step skips what is already in place):
#   - Node.js 24, pnpm (corepack), PM2; PostgreSQL (16 on 24.04, 18 on 26.04) + pgvector; Redis 7 with maxmemory-policy noeviction
#   - if .env exists: creates the database role/database from DATABASE_URL (local only) with the vector and pgcrypto
#     extensions, and sets the Redis password from REDIS_URL (requirepass) when it has one
#   - firewall (ufw): allow SSH (detected port), 80 and 443; deny the rest incoming. Skip with --no-firewall.
#   - Nginx; with --domain: site from nginx/native.conf.template + Let's Encrypt certificate (certbot --nginx)
#   - Workspace-mode sandbox prerequisites: checks systemd ≥ 252 and cgroup v2. No runner user is created: every run
#     is a transient systemd unit with its own dynamic user (docs/upgrade/SPIKE-sandbox.md)
#   - Workspace-mode toolchain (git, Python 3 + document libraries, LibreOffice headless, pandoc, poppler, qpdf, tesseract)
# Do not run it on a host that already serves other apps without reading it first (firewall, Redis password).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "warning: tested for Ubuntu 24.04 and 26.04 only (found ${PRETTY_NAME:-unknown})" >&2
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ONLY_TOOLCHAIN=0 FIREWALL=1 DOMAIN="" EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --toolchain) ONLY_TOOLCHAIN=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -z "$DOMAIN" ] || [ -n "$EMAIL" ] || { echo "--domain needs --email (Let's Encrypt account)" >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
TOOLS=/opt/wfos-tools
apt_install() { apt-get install -y --no-install-recommends "$@"; }
# value of KEY from .env (no shell evaluation of the file)
envval() { [ -f "$APP_DIR/.env" ] && sed -nE "s/^$1=['\"]?([^'\"]*)['\"]?\s*$/\1/p" "$APP_DIR/.env" | tail -1; }

if [ "$ONLY_TOOLCHAIN" = 0 ]; then
  echo "== packages"
  apt-get update -q
  # the release's own PostgreSQL major (16 on 24.04, 18 on 26.04); a pg_dump from an older major restores into it
  PG_MAJOR="$(apt-cache depends postgresql 2>/dev/null | sed -nE 's/.*Depends: postgresql-([0-9]+)$/\1/p' | head -1)"
  PG_MAJOR="${PG_MAJOR:-16}"
  apt_install ca-certificates curl gnupg git nginx ufw "postgresql-$PG_MAJOR" "postgresql-$PG_MAJOR-pgvector" redis-server python3

  echo "== Node.js 24, pnpm, PM2"
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt_install nodejs
  fi
  corepack enable
  command -v pm2 >/dev/null || npm install -g pm2@6

  # next build/start run in apps/web and only read .env from there: without this link the web has no DATABASE_URL
  [ -e "$APP_DIR/apps/web/.env" ] || ln -s ../../.env "$APP_DIR/apps/web/.env"

  echo "== Redis: never evict queue data; local only"
  conf=/etc/redis/redis.conf
  changed=0
  if ! grep -q '^maxmemory-policy noeviction' "$conf"; then
    sed -i 's/^#\? *maxmemory-policy .*/maxmemory-policy noeviction/' "$conf"
    grep -q '^maxmemory-policy noeviction' "$conf" || echo 'maxmemory-policy noeviction' >> "$conf"
    changed=1
  fi
  grep -qE '^bind 127\.0\.0\.1' "$conf" || { sed -i 's/^#\? *bind .*/bind 127.0.0.1 -::1/' "$conf"; changed=1; }
  redis_url="$(envval REDIS_URL || true)"
  redis_pw="$(python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).password or "")' "${redis_url:-redis://localhost}")"
  if [ -n "$redis_pw" ] && ! grep -qxF "requirepass $redis_pw" "$conf"; then
    sed -i '/^requirepass /d' "$conf"; echo "requirepass $redis_pw" >> "$conf"; changed=1
  fi
  [ "$changed" = 0 ] || systemctl restart redis-server

  echo "== PostgreSQL: local only; database from .env"
  db_url="$(envval DATABASE_URL || true)"
  if [ -n "$db_url" ]; then
    # unit separator: passwords may contain spaces, and empty fields must stay empty
    IFS=$'\x1f' read -r db_host db_user db_pass db_name < <(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print("\x1f".join([p.hostname or "", u.unquote(p.username or ""), u.unquote(p.password or ""), p.path.lstrip("/")]))' "$db_url")
    if [ "$db_host" = 127.0.0.1 ] || [ "$db_host" = localhost ]; then
      psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -Atq "$@"; }
      if [ "$(psql_su -c "select 1 from pg_roles where rolname='$db_user'")" != 1 ]; then
        if [ -n "$db_pass" ]; then psql_su -c "CREATE ROLE \"$db_user\" LOGIN PASSWORD '${db_pass//\'/\'\'}'"; else psql_su -c "CREATE ROLE \"$db_user\" LOGIN"; fi
      fi
      [ "$(psql_su -c "select 1 from pg_database where datname='$db_name'")" = 1 ] || psql_su -c "CREATE DATABASE \"$db_name\" OWNER \"$db_user\""
      psql_su -d "$db_name" -c "CREATE EXTENSION IF NOT EXISTS vector" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
      echo "database $db_name (owner $db_user) ready"
    else
      echo "DATABASE_URL points to $db_host: not creating anything (remote database)"
    fi
  else
    echo "no .env yet: create it (cp .env.example .env), then re-run to create the database"
  fi

  if [ "$FIREWALL" = 1 ]; then
    echo "== firewall (ufw)"
    # awk exits at the first match, so sshd may die of SIGPIPE: under pipefail that must not abort the script
    ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)"
    ufw allow "${ssh_port:-22}/tcp" >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw default deny incoming >/dev/null
    ufw --force enable >/dev/null
    ufw status | head -12
  fi

  if [ -n "$DOMAIN" ]; then
    echo "== Nginx + HTTPS for $DOMAIN"
    site=/etc/nginx/sites-available/workforce-os
    if [ ! -f "$site" ]; then
      sed "s/\${DOMAIN}/$DOMAIN/g" "$APP_DIR/nginx/native.conf.template" > "$site"
      ln -sf "$site" /etc/nginx/sites-enabled/workforce-os
      rm -f /etc/nginx/sites-enabled/default
    fi
    nginx -t && systemctl reload nginx
    apt_install certbot python3-certbot-nginx
    [ -d "/etc/letsencrypt/live/$DOMAIN" ] || certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect
  fi

  echo "== Workspace-mode sandbox prerequisites"
  sd="$(systemctl --version | awk 'NR==1{print $2}')"
  [ "${sd:-0}" -ge 252 ] && echo "systemd $sd ok" || echo "warning: systemd $sd < 252: Workspace mode will not start (Tool mode works)"
  [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] && echo "cgroup v2 ok" || echo "warning: cgroup v2 missing: Workspace mode will not start"
fi

echo "== Workspace-mode toolchain (git, Python 3 + uv, LibreOffice headless, pandoc, poppler, qpdf, tesseract eng+ind)"
apt-get update -q
apt_install git python3 python3-venv pandoc poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-ind \
  libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu fonts-liberation
if [ ! -x "$TOOLS/venv/bin/python" ]; then
  mkdir -p "$TOOLS"
  python3 -m venv "$TOOLS/venv"
fi
# pinned document libraries, readable (not writable) from every sandbox
"$TOOLS/venv/bin/pip" install --quiet --upgrade pip==24.3.1
"$TOOLS/venv/bin/pip" install --quiet \
  uv==0.5.11 python-docx==1.1.2 openpyxl==3.1.5 python-pptx==1.0.2 pypdf==5.1.0 pdfplumber==0.11.4 reportlab==4.2.5
chmod -R a+rX,go-w "$TOOLS"

echo "== checks"
git --version; soffice --version 2>/dev/null | head -1 || true; pandoc --version | head -1; tesseract --list-langs 2>/dev/null | tr '\n' ' '; echo
cat <<'NEXT'
done. Next (as root, in the checkout):
  pnpm install --frozen-lockfile && pnpm db:migrate && pnpm build
  pm2 start ecosystem.config.cjs && pm2 save && pm2 startup systemd
  curl -s http://127.0.0.1:3010/api/health      # expect "status":"ok"
NEXT
