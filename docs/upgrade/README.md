# Workforce OS upgrade (v2): index, status and remaining limits

| Document | Content |
|---|---|
| [DECISIONS.md](DECISIONS.md) | D1–D29: every design decision with what was rejected and why |
| [SPIKE-sandbox.md](SPIKE-sandbox.md) | Phase 1.0 isolation spike on this host (design (b), approved) |
| [PHASE-0.md](PHASE-0.md) … [PHASE-4.md](PHASE-4.md) | One report per phase: what changed, how it was verified, limits |
| [I18N.md](I18N.md) | Conventions for the Bahasa Indonesia / English UI |
| [../DEPLOY.md](../DEPLOY.md) | Fresh VPS → HTTPS, credentials, backups, upgrades, key rotation, Docker |

## Definition of done: status

| Item | Status |
|---|---|
| `pnpm -r typecheck`, all tests, lint green | ✔ shared 455, worker 74, web 62, system 29, deploy scripts (`pnpm test:deploy`) |
| Safety suites 0.1, 0.2 and 1.3 exist and pass | ✔ `packages/shared/test/{gate,guards,classify,bash-classifier,netguard}.test.ts`, `apps/worker/test/{approvals,audit,runner}.test.ts` |
| Fresh Ubuntu VM: clone + `.env` + `setup-ubuntu.sh` + migrations + `pm2 start` | ✔ native: production moved to a fresh Ubuntu 26.04 VPS (workforce-os.property365.co.id, 2026-10-09) set up this way, with `--toolchain`. ⧗ `docker compose up -d` not run yet |
| Production never disturbed | ✔ PM2 `wfos-*` never restarted (restart counts unchanged), production DB not migrated (still 3 migrations), no production queue touched (dev Redis db 13 + namespace `wfos-dev`, tests db 14 + mocks), production checkout untouched |
| Developer in Workspace mode: task → edit in sandbox → tests → commit → diff → approval → push + PR | ✔ against the real Claude Code CLI with a stub API and real systemd sandboxes: `apps/worker/test/system/agent-e2e.test.ts` ("edits, tests, commits, uses platform tools and queues a risky command for approval"), `git-delivery.test.ts` ("clones…, exports the commit, shows the diff and pushes exactly the approved commit", "opens a pull request with the platform token"). ⧗ **Owner:** a manual smoke test against the real Claude service |
| Cannot read platform secrets or reach a non-allow-listed host | ✔ `apps/worker/test/system/sandbox-boundary.test.ts`: "cannot see or read the worker process (it holds DATABASE_URL and ENCRYPTION_KEY)", "has an environment with no platform secrets", "cannot reach Postgres, Redis or the web app on the host", "has no direct internet access", "is refused for hosts that are not allow-listed", "cannot use the proxy to reach host services" |
| UI fully in Bahasa Indonesia and English | ✔ every catalog in `apps/web/messages/{id,en}`; `apps/web/test/i18n.test.ts` fails on missing keys or hard-coded UI strings |
| `docs/upgrade/` complete | ✔ this folder |

## Remaining limits (honest list)

1. **No real-service smoke test yet.** Workspace mode was proven with the real Claude Code CLI against a local stub of
   the Anthropic API. The first run against the real service is the owner's manual check:
   `sdk-smoke.ts`, then a Developer task.
2. **`docker compose up` not run on a fresh VM yet.** The native `setup-ubuntu.sh` path was: production now runs on a
   fresh Ubuntu 26.04 VPS set up with it. The Docker image had a broken install stage since Phase 1 (fixed, and now
   guarded by a test), which shows why this check matters.
3. **One Workspace-mode run at a time by default** (`WORKSPACE_CONCURRENCY=1`; each Claude Code process needs
   300–500 MB). The old 2 GB host needed that, and swap or a short web stop to build; the current 8 GB VPS can raise it.
4. **Workspace mode needs the native install** (root + systemd). Under Docker it fails closed; Tool mode works.
5. **Toolchain is optional** (`setup-ubuntu.sh --toolchain`): without it, document skills that need
   LibreOffice/pandoc/tesseract fail. The current production VPS has it.
6. **Live office:** it follows the last recorded step, so it can trail the real action by one tool call. The
   60 fps / 30 employees target was checked only by reasoning and a headless render, not measured on a mid-range
   laptop.
7. **Upgrades:**
   - Rollback restores code, not schema: migrations are additive by convention, and the pre-migration backup is the
     way back.
   - With one web instance, a reload is a few seconds of downtime.
8. **Subscription meter** updates only while agents run (no polling), and stores no overage fields.
9. **Telegram:** one bot per installation; Edit & Approve is web-only. **Push on iOS** needs the app on the Home
   Screen.
10. **Production host:** the Phase 0 findings (password-less Redis, Postgres on all interfaces, inactive firewall)
    were on the old host (ai.vardiv.id), which production has left. The new VPS (2026-10-09) has the firewall active
    and Postgres and Redis on localhost only, but Redis still has no password, because its `REDIS_URL` had none when
    `setup-ubuntu.sh` ran. Fix: put a password in `REDIS_URL`, re-run `setup-ubuntu.sh --no-firewall` (it sets
    `requirepass`), restart `wfos-web` and `wfos-worker`.
