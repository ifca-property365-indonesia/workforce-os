#!/usr/bin/env bash
# Exercises deploy/upgrade.sh against throwaway git repos with stub pnpm / pm2 / curl / backup on PATH:
# success, already up to date, low RAM, local changes, busy worker, build failure, failed health and a stale worker
# all end in the right commit with the right commands run. Nothing touches PM2, the network or a database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$WORK/out" ]] && sed 's/^/    /' "$WORK/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

# stubs: log every call; behaviour is switched by files in $WORK
mkdir -p "$WORK/bin"
cat > "$WORK/bin/pnpm" <<'SH'
#!/usr/bin/env bash
echo "pnpm $*" >> "$WORK/calls"
[[ "$*" = build && -f "$WORK/fail_build" && "$(git rev-parse HEAD)" = "$(cat "$WORK/fail_build")" ]] && exit 1
exit 0
SH
cat > "$WORK/bin/pm2" <<'SH'
#!/usr/bin/env bash
echo "pm2 $*" >> "$WORK/calls"
# pm2 reload records which commit the "new processes" run
[[ "$1" = reload ]] && git -C "$APP_DIR" rev-parse --short=12 HEAD > "$WORK/reloaded"
exit 0
SH
cat > "$WORK/bin/curl" <<'SH'
#!/usr/bin/env bash
# health of the "running" instance: the worker reports the commit that was last reloaded
url="${@: -1}"
echo "curl $url" >> "$WORK/calls"
mode="$(cat "$WORK/health_mode" 2>/dev/null || echo ok)"
runs="$(cat "$WORK/active_runs" 2>/dev/null || echo 0)"
if [[ -f "$WORK/busy_polls" && "$(cat "$WORK/busy_polls")" -gt 0 ]]; then echo $(( $(cat "$WORK/busy_polls") - 1 )) > "$WORK/busy_polls"; runs=1; fi
commit="$(cat "$WORK/reloaded" 2>/dev/null || git -C "$APP_DIR" rev-parse --short=12 HEAD)"
[[ "$mode" = stale ]] && commit="000000000000"
status=ok; [[ "$mode" = fail && "$(git -C "$APP_DIR" rev-parse HEAD)" = "$(cat "$WORK/fail_health_at")" ]] && status=degraded
echo "{\"status\":\"$status\",\"commit\":\"$commit\",\"checks\":{\"worker\":{\"activeRuns\":$runs}}}"
SH
cat > "$WORK/bin/backup" <<'SH'
#!/usr/bin/env bash
echo "backup" >> "$WORK/calls"
SH
chmod +x "$WORK/bin/"*
printf 'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n' > "$WORK/meminfo-ok"
printf 'MemTotal: 2000000 kB\nMemAvailable: 900000 kB\n' > "$WORK/meminfo-low"

# origin with two commits; the app is a clone sitting on the first
setup() {
  rm -rf "$WORK/origin.git" "$WORK/app" "$WORK/calls" "$WORK/reloaded" "$WORK/fail_build" "$WORK/health_mode" "$WORK/fail_health_at" "$WORK/active_runs" "$WORK/busy_polls"
  git init -q --bare -b main "$WORK/origin.git"
  git clone -q "$WORK/origin.git" "$WORK/seed" 2>/dev/null
  mkdir -p "$WORK/seed/deploy"
  cp "$ROOT/deploy/upgrade.sh" "$WORK/seed/deploy/upgrade.sh"
  echo "module.exports = { apps: [] };" > "$WORK/seed/ecosystem.config.cjs"
  echo "storage/" > "$WORK/seed/.gitignore"
  echo v1 > "$WORK/seed/VERSION"
  git -C "$WORK/seed" add -A && git -C "$WORK/seed" -c user.email=t@t -c user.name=t commit -qm v1
  git -C "$WORK/seed" push -q origin main
  git clone -q "$WORK/origin.git" "$WORK/app"
  echo v2 > "$WORK/seed/VERSION"
  git -C "$WORK/seed" -c user.email=t@t -c user.name=t commit -qam v2
  git -C "$WORK/seed" push -q origin main
  rm -rf "$WORK/seed"
  V1="$(git -C "$WORK/app" rev-parse HEAD)"
  V2="$(git -C "$WORK/origin.git" rev-parse main)"
}
run() {
  env PATH="$WORK/bin:$PATH" WORK="$WORK" APP_DIR="$WORK/app" MEMINFO="${MEMINFO:-$WORK/meminfo-ok}" BACKUP_CMD="$WORK/bin/backup" \
    HEALTH_TIMEOUT_SEC=2 POLL_SEC=1 WAIT_IDLE_SEC="${WAIT_IDLE_SEC:-3}" UPGRADE_LOG="$WORK/upgrade.log" \
    bash "$WORK/app/deploy/upgrade.sh" "$@" > "$WORK/out" 2>&1
}
head_is() { [[ "$(git -C "$WORK/app" rev-parse HEAD)" = "$1" ]]; }
called() { grep -qxF "$1" "$WORK/calls" 2>/dev/null; }
order() { grep -vE '^curl' "$WORK/calls" | tr '\n' '|'; }

setup
run || fail "successful upgrade exited non-zero"
head_is "$V2" || fail "not on the new commit"
[[ "$(order)" = "backup|pnpm install --frozen-lockfile|pnpm db:migrate|pnpm build|pm2 reload ecosystem.config.cjs --update-env|" ]] || fail "unexpected steps: $(order)"
grep -q "upgrade ok" "$WORK/out" || fail "no success line"
pass "upgrades: backup → install → migrate → build → reload → healthy on the new commit"

run || fail "second run failed"
grep -q "already up to date" "$WORK/out" || fail "did not detect up to date"
pass "a second run is a no-op"

setup
if MEMINFO="$WORK/meminfo-low" run; then fail "built with too little RAM"; fi
head_is "$V1" && ! called "pnpm install --frozen-lockfile" || fail "changed something before the RAM check"
MEMINFO="$WORK/meminfo-low" run --stop-web-for-build || fail "--stop-web-for-build failed"
head_is "$V2" && called "pm2 stop wfos-web" || fail "--stop-web-for-build did not stop the web for the build"
pass "refuses to build with too little RAM unless --stop-web-for-build"

setup
echo dirty >> "$WORK/app/VERSION"
if run; then fail "upgraded a dirty checkout"; fi
head_is "$V1" || fail "moved a dirty checkout"
pass "refuses to run with local changes"

setup
echo 1 > "$WORK/active_runs"
if run; then fail "upgraded while a run was active"; fi
head_is "$V1" && ! called "backup" || fail "changed something while waiting"
rm "$WORK/active_runs"; echo 2 > "$WORK/busy_polls"
WAIT_IDLE_SEC=10 run || fail "did not proceed after the runs finished"
head_is "$V2" || fail "not upgraded after waiting"
pass "waits for active agent runs, gives up without changes after WAIT_IDLE_SEC"

setup
echo "$V2" > "$WORK/fail_build"
if run; then fail "a failed build reported success"; fi
head_is "$V1" || fail "not rolled back after a failed build"
grep -q "rolled back to $V1 and healthy" "$WORK/out" || fail "no rollback line"
[[ "$(cat "$WORK/reloaded")" = "${V1:0:12}" ]] || fail "rollback did not reload the old code"
pass "a failed build rolls back to the recorded commit, rebuilds and reloads it"

setup
echo fail > "$WORK/health_mode"; echo "$V2" > "$WORK/fail_health_at"
if run; then fail "an unhealthy upgrade reported success"; fi
head_is "$V1" || fail "not rolled back after a failed health check"
grep -q "FAILED at: health" "$WORK/out" || fail "wrong failure stage"
pass "a failed health check rolls back"

setup
echo stale > "$WORK/health_mode"
if run; then fail "accepted a worker still reporting the old commit"; fi
grep -q "FAILED at: health" "$WORK/out" || fail "stale worker not detected"
grep -q "ROLLBACK FAILED" "$WORK/out" || fail "rollback health should also fail with a stale worker"
pass "the new worker must report the new commit (a stale heartbeat is not healthy)"

echo "upgrade.sh: all checks passed"
