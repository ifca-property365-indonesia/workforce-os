# Phase 4 — Operations

## What changed

| Item | Where |
|---|---|
| **Native setup** (idempotent):<br>• Node 24/pnpm/PM2, PostgreSQL 16 + pgvector, Redis 7 (`noeviction`, local only)<br>• database role/database and Redis password from `.env`<br>• ufw (SSH port detected, 80, 443)<br>• Nginx + Let's Encrypt with `--domain`<br>• sandbox prerequisite checks (systemd ≥ 252, cgroup v2), toolchain | `deploy/setup-ubuntu.sh`, `nginx/native.conf.template` |
| PM2: `wfos-web` (optional cluster mode, `WFOS_WEB_INSTANCES`, for reloads without downtime) and `wfos-worker`; no `wfos-runner` process (D27) | `ecosystem.config.cjs` |
| **Health:** the worker heartbeat (commit, active runs, systemd/runner/Claude readiness, 75 s TTL) and `/api/health` with `ok` / `degraded` / `down` and `?strict=1`. The response carries booleans only (D28) | `packages/shared/src/ops.ts`, `apps/worker/src/lib/heartbeat.ts`, `api/health` |
| **Backups:** git mirrors, a checksum manifest and an `ENV_FILE` override added. **Restore:** checksum check; refuses a non-empty target, existing files or an existing `.env`; `--exit-on-error` | `deploy/backup.sh`, `deploy/restore.sh` |
| **Upgrade:** fast-forward only; dirty-tree and RAM checks; waits for active runs; backup → install → migrate → build → `pm2 reload` → health must report the new commit; automatic rollback | `deploy/upgrade.sh` |
| **Key rotation:** `ENCRYPTION_KEY_PREVIOUS` decrypt fallback + `cli rotate-key` (one transaction) (D29) | `packages/shared/src/server.ts`, `packages/db/src/rotate.ts`, `cli.ts` |
| **Seed:** no default account with a known password; `SEED_DEMO=true` creates a random, must-change password (D29) | `packages/db/src/seed.ts`, `seed-plan.ts` |
| **Docker:** deps stage fixed (missing `packages/runner`, broken since Phase 1); commit passed as a build arg | `Dockerfile`, `docker-compose.yml` |
| One-page deploy guide: fresh VPS → HTTPS, Claude credential per workspace, health, backups/restore, upgrades, rotating every key, Docker | `docs/DEPLOY.md` |

## How it was verified

- `pnpm -r typecheck` ✔, `pnpm lint` ✔.
- `pnpm test` ✔ (shared 455, worker 74, web 62).
- `pnpm test:system` ✔ (29).
- `pnpm test:deploy` ✔.

Details:
- `deploy/test/upgrade.sh` runs the real `upgrade.sh` against throwaway git repos, with stub `pnpm`/`pm2`/`curl`/backup on
  PATH, through eight scenarios:
  1. success, in the exact step order;
  2. a second run is a no-op;
  3. low RAM aborts before any change, and `--stop-web-for-build` proceeds;
  4. a dirty checkout is refused;
  5. active runs are waited for, and it gives up without changes after the limit;
  6. a failed build rolls back to the recorded commit, rebuilds and reloads it;
  7. a failed health check rolls back;
  8. a worker still reporting the old commit is not accepted.
- `deploy/test/backup-restore.sh` works on three throwaway databases created from the test template and dropped after:
  - backup, then the guard rails: non-empty target, damaged checksum, existing uploads;
  - restore with `--exit-on-error`, then an identical schema dump, identical row hashes (including pgvector values),
    and byte-identical uploads, git mirrors and `.env`.
- `packages/shared/test/ops.test.ts` covers the health verdict. `apps/web/test/health.test.ts` covers degraded vs strict,
  a stale heartbeat, the sandbox counting only with Workspace mode, and redis down giving 503 without error text.
  `apps/worker/test/heartbeat.test.ts` covers the heartbeat itself.
- `apps/worker/test/rotate.test.ts`: the old key decrypts during rotation; after `reencryptAll`, everything opens with the
  new key alone; a wrong key aborts and changes nothing. The CLI also ran against the dev database.
- `apps/worker/test/seed-plan.test.ts`: no account by default; random and must-change with `SEED_DEMO`.
  `packages/shared/test/repo-consistency.test.ts`: the Dockerfile covers every lockfile importer, and every env var
  read by the code is documented.

**Not executed here** (by the brief's rules for this host):
- `setup-ubuntu.sh` (installs packages, changes the firewall);
- `docker compose` (Docker is not installed);
- `upgrade.sh` against the real PM2 processes;
- a production build.

They need the fresh-VM check in the definition of done.

## For the owner

- Production is on commit `c26afb6` with 3 of 12 migrations. Review, then run `deploy/backup.sh`, then
  `pnpm db:migrate` (0003–0011), then build and reload, or use `deploy/upgrade.sh` once `upgrade/v2` is merged into the
  branch production tracks.
- Recommended, from the Phase 0 findings on this host:
  - set a Redis password (`REDIS_URL` + `requirepass`);
  - make Postgres listen on localhost only, or enable the firewall.
  `setup-ubuntu.sh` does both on a fresh server. On this host, run the steps by hand after reading them: it also
  serves other apps.
- On this 2 GB host, building needs swap or `deploy/upgrade.sh --stop-web-for-build` (a short downtime).
