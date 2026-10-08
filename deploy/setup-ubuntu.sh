#!/usr/bin/env bash
# Workforce OS — idempotent setup for a fresh Ubuntu 24.04 server (run as root, re-run safely).
#
#   ./deploy/setup-ubuntu.sh               platform prerequisites + Workspace-mode toolchain
#   ./deploy/setup-ubuntu.sh --toolchain   only the Workspace-mode toolchain
#
# It does NOT touch an existing database, change firewall rules or AppArmor, or create users:
# Workspace-mode sandboxes are transient systemd units with dynamic users (see docs/upgrade/SPIKE-sandbox.md).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "warning: tested on Ubuntu 24.04 only (found ${PRETTY_NAME:-unknown})" >&2

ONLY_TOOLCHAIN=0
[ "${1:-}" = "--toolchain" ] && ONLY_TOOLCHAIN=1
export DEBIAN_FRONTEND=noninteractive
TOOLS=/opt/wfos-tools

apt_install() { apt-get install -y --no-install-recommends "$@"; }

if [ "$ONLY_TOOLCHAIN" = 0 ]; then
  echo "== platform prerequisites"
  apt-get update -q
  apt_install ca-certificates curl gnupg git nginx
  # PostgreSQL 16 + pgvector, Redis 7 (Ubuntu 24.04 packages)
  apt_install postgresql-16 postgresql-16-pgvector redis-server
  # Redis must never evict queue data
  if ! grep -q '^maxmemory-policy noeviction' /etc/redis/redis.conf; then
    sed -i 's/^#\? *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
    grep -q '^maxmemory-policy noeviction' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
    systemctl restart redis-server
  fi
  # Node.js 24 (NodeSource) + pnpm via corepack + PM2
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt_install nodejs
  fi
  corepack enable
  command -v pm2 >/dev/null || npm install -g pm2@6
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
command -v systemd-run >/dev/null && systemd-run --version | head -1
git --version; soffice --version 2>/dev/null | head -1 || true; pandoc --version | head -1; tesseract --list-langs 2>/dev/null | tr '\n' ' '; echo
echo "done. Next: cp .env.example .env, fill it in, pnpm install --frozen-lockfile, pnpm db:migrate, pnpm build, pm2 start ecosystem.config.cjs"
