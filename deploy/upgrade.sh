#!/usr/bin/env bash
# Upgrade a native (PM2) install in place, with automatic rollback. Run by the owner on the server:
#
#   deploy/upgrade.sh                    # upgrade to the upstream of the current branch
#   deploy/upgrade.sh --ref origin/main  # or to a given ref (fast-forward only)
#
# Order: record the current commit → fetch → check free RAM → wait until no agent run and no app deploy is active → backup →
# fast-forward → pnpm install --frozen-lockfile → migrations → build → pm2 reload → health check (the new worker
# must report the new commit). Any failure after the fast-forward rolls the code back to the recorded commit,
# reinstalls, rebuilds, reloads and checks health again. Migrations are additive and are not rolled back; the backup
# taken before them is the way back for the data (deploy/restore.sh).
#
# Options: --ref REF  --skip-backup  --stop-web-for-build (frees RAM for the build; the site is down meanwhile)
# Env: MIN_FREE_MB (1500)  WAIT_IDLE_SEC (900)  HEALTH_TIMEOUT_SEC (180)  HEALTH_URL  UPGRADE_LOG  DEPLOYS_HOLD_FILE
#
# App deploys are held for the whole upgrade: before waiting for idle, the hold file is created
# (DEPLOYS_HOLD_FILE, default "<STORAGE_DIR>/deploys.hold"; STORAGE_DIR from the env or .env, a relative one is
# relative to the app dir, default ./storage). The worker delays deploy jobs while it exists (one older than 2 h is
# ignored as stale). It is removed on every exit (trap), also after a rollback or an abort. The worker counts a deploy
# job and writes its heartbeat before it looks at the file, so any deploy that got past the hold already shows in
# checks.worker.activeDeploys when the wait below reads it.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3010/api/health}"
MIN_FREE_MB="${MIN_FREE_MB:-1500}"
WAIT_IDLE_SEC="${WAIT_IDLE_SEC:-900}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-180}"
MEMINFO="${MEMINFO:-/proc/meminfo}"
BACKUP_CMD="${BACKUP_CMD:-$APP_DIR/deploy/backup.sh}"
UPGRADE_LOG="${UPGRADE_LOG:-$APP_DIR/storage/upgrade.log}"
POLL_SEC="${POLL_SEC:-5}"
if [[ -z "${DEPLOYS_HOLD_FILE:-}" && -f "$APP_DIR/.env" ]]; then
  DEPLOYS_HOLD_FILE="$(sed -n 's/^DEPLOYS_HOLD_FILE=//p' "$APP_DIR/.env" | tail -n 1 | tr -d "\"'")"
fi
if [[ -z "${DEPLOYS_HOLD_FILE:-}" ]]; then
  storage="${STORAGE_DIR:-}"
  if [[ -z "$storage" && -f "$APP_DIR/.env" ]]; then storage="$(sed -n 's/^STORAGE_DIR=//p' "$APP_DIR/.env" | tail -n 1 | tr -d "\"'")"; fi
  storage="${storage:-./storage}"
  [[ "$storage" = /* ]] || storage="$APP_DIR/${storage#./}"
  DEPLOYS_HOLD_FILE="$storage/deploys.hold"
fi

REF="" SKIP_BACKUP=0 STOP_WEB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --stop-web-for-build) STOP_WEB=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$UPGRADE_LOG")"
exec > >(tee -a "$UPGRADE_LOG") 2>&1
log() { echo "$(date -Is) $*"; }
die() { log "ABORT: $*"; exit 1; }
cd "$APP_DIR"

# --- preflight: nothing has changed yet ------------------------------------------------------------------------
git diff --quiet && git diff --cached --quiet || die "the checkout has local changes; commit or stash them first"
PREV="$(git rev-parse HEAD)"
log "current commit $PREV"
git fetch --quiet
TARGET="$(git rev-parse "${REF:-@{u\}}")"
if [[ "$TARGET" = "$PREV" ]]; then log "already up to date"; exit 0; fi
git merge-base --is-ancestor "$PREV" "$TARGET" || die "$TARGET is not a fast-forward of $PREV"
log "upgrading to $TARGET ($(git log --oneline "$PREV..$TARGET" | wc -l) commits)"

free_mb="$(awk '/^MemAvailable:/ {print int($2/1024)}' "$MEMINFO")"
if [[ "$free_mb" -lt "$MIN_FREE_MB" && "$STOP_WEB" != 1 ]]; then
  die "only ${free_mb} MB available, the build needs ${MIN_FREE_MB} MB (add swap, or use --stop-web-for-build)"
fi

health_json() { curl -fsS --max-time 10 "$1" 2>/dev/null || true; }
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(d));console.log(v??"")}catch{console.log("")}})' "$1"; }

# hold app deploys from here to the end (the worker delays new deploy jobs while the file exists)
HOLDING=0
release_hold() { if [[ "$HOLDING" = 1 ]]; then rm -f "$DEPLOYS_HOLD_FILE"; HOLDING=0; fi; }
trap release_hold EXIT
mkdir -p "$(dirname "$DEPLOYS_HOLD_FILE")"
echo "upgrade $$ $(date -Is)" > "$DEPLOYS_HOLD_FILE"
HOLDING=1
log "app deploys held ($DEPLOYS_HOLD_FILE)"

# agent runs and app deploys (a build on this host, or a release half switched on) must not be cut by the reload;
# a field missing from an older worker counts as 0
waited=0
while :; do
  hj="$(health_json "$HEALTH_URL")"
  runs="$(field checks.worker.activeRuns <<< "$hj")"; runs="${runs:-0}"
  deploys="$(field checks.worker.activeDeploys <<< "$hj")"; deploys="${deploys:-0}"
  [[ "$runs" = 0 && "$deploys" = 0 ]] && break
  [[ "$waited" -ge "$WAIT_IDLE_SEC" ]] && die "$runs agent run(s) and $deploys app deploy(s) still active after ${WAIT_IDLE_SEC}s; try again later"
  log "waiting for $runs active run(s) and $deploys app deploy(s) to finish"
  sleep "$POLL_SEC"; waited=$((waited + POLL_SEC))
done

if [[ "$SKIP_BACKUP" != 1 ]]; then
  log "backup"
  "$BACKUP_CMD" || die "backup failed"
fi

# --- from here on, failures roll back ---------------------------------------------------------------------------
STAGE=""
healthy() {
  local want="${1:0:12}" deadline=$((SECONDS + HEALTH_TIMEOUT_SEC)) j
  while [[ $SECONDS -lt $deadline ]]; do
    j="$(health_json "$HEALTH_URL?strict=1")"
    if [[ "$(field status <<< "$j")" = ok && "$(field commit <<< "$j")" = "$want"* ]]; then return 0; fi
    sleep "$POLL_SEC"
  done
  return 1
}
deploy_current() {
  # explicit checks: errexit does not apply inside a function used as a condition
  STAGE="install"; pnpm install --frozen-lockfile || return 1
  if [[ "${1:-}" = migrate ]]; then STAGE="migrate"; pnpm db:migrate || return 1; fi
  if [[ "$STOP_WEB" = 1 ]]; then STAGE="stop web"; pm2 stop wfos-web || return 1; fi
  STAGE="build"; pnpm build || return 1
  STAGE="reload"; pm2 reload ecosystem.config.cjs --update-env || return 1
  STAGE="health"; healthy "$(git rev-parse HEAD)" || return 1
}
rollback() {
  log "FAILED at: $STAGE. Rolling back to $PREV"
  git reset --keep "$PREV" || { log "could not reset the checkout; fix it by hand (git status)"; exit 3; }
  if deploy_current; then
    log "rolled back to $PREV and healthy. Migrations of the failed version stay applied (additive)."
    exit 1
  fi
  log "ROLLBACK FAILED at: $STAGE. The site may be down: check pm2 logs; the backup is in \$BACKUP_DIR"
  exit 3
}

git merge --ff-only --quiet "$TARGET" || die "fast-forward failed"
deploy_current migrate || rollback
log "upgrade ok: $PREV → $TARGET, healthy"
