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
| Fresh Ubuntu 24.04 VM: clone + `.env` + `setup-ubuntu.sh` + migrations + `pm2 start` | ⧗ **Owner:** scripts and guide are ready (`docs/DEPLOY.md`); not run, because this host is production. `docker compose up -d` likewise (no Docker here) |
| Production never disturbed | ✔ PM2 `wfos-*` never restarted (restart counts unchanged), production DB not migrated (still 3 migrations), no production queue touched (dev Redis db 13 + namespace `wfos-dev`, tests db 14 + mocks), production checkout untouched |
| Developer in Workspace mode: task → edit in sandbox → tests → commit → diff → approval → push + PR | ✔ against the real Claude Code CLI with a stub API and real systemd sandboxes: `apps/worker/test/system/agent-e2e.test.ts` ("edits, tests, commits, uses platform tools and queues a risky command for approval"), `git-delivery.test.ts` ("clones…, exports the commit, shows the diff and pushes exactly the approved commit", "opens a pull request with the platform token"). ⧗ **Owner:** a manual smoke test against the real Claude service |
| Cannot read platform secrets or reach a non-allow-listed host | ✔ `apps/worker/test/system/sandbox-boundary.test.ts`: "cannot see or read the worker process (it holds DATABASE_URL and ENCRYPTION_KEY)", "has an environment with no platform secrets", "cannot reach Postgres, Redis or the web app on the host", "has no direct internet access", "is refused for hosts that are not allow-listed", "cannot use the proxy to reach host services" |
| UI fully in Bahasa Indonesia and English | ✔ every catalog in `apps/web/messages/{id,en}`; `apps/web/test/i18n.test.ts` fails on missing keys or hard-coded UI strings |
| `docs/upgrade/` complete | ✔ this folder |

## Remaining limits (honest list)

1. **No real-service smoke test yet.** Workspace mode was proven with the real Claude Code CLI against a local stub of
   the Anthropic API. The first run against the real service is the owner's manual check:
   `sdk-smoke.ts`, then a Developer task.
2. **Fresh-VM run of `setup-ubuntu.sh` and `docker compose up` not done** (they cannot run on this production host).
   The Docker image had a broken install stage since Phase 1 (fixed, and now guarded by a test), which shows why this
   check matters.
3. **This host fits one Workspace-mode run at a time** (`WORKSPACE_CONCURRENCY=1`; each Claude Code process needs
   300–500 MB). Builds need swap or a short web stop.
4. **Workspace mode needs the native install** (root + systemd). Under Docker it fails closed; Tool mode works.
5. **Toolchain not installed on this host** (`setup-ubuntu.sh --toolchain` is the owner's call): document skills that
   need LibreOffice/pandoc/tesseract fail until then.
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
10. **This production host** still has a password-less Redis and a Postgres listening on all interfaces with an
    inactive firewall (found in Phase 0). The fix commands are in PHASE-4.md; they are the owner's to run.
