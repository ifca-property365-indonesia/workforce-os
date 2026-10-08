# Phase 0 — Foundation hardening

Branch `upgrade/v2` (worktree `/root/apps/workforce-os-v2`). Production (`/root/apps/workforce-os`, PM2 `wfos-*`,
database `workforce_os`, Redis DB 3) was not touched: no restart, no migration, no queue access.

## What changed

| Item | Change | Where |
|---|---|---|
| Dev/test isolation | `WFOS_ENV`/`WFOS_NAMESPACE` guard: worker, web, migrate and seed refuse to start in dev/test against the production DB, Redis or namespace. BullMQ prefix and pub/sub channels are namespaced (pub/sub ignores the Redis DB index) | `packages/shared/src/runtime.ts` |
| 0.1 Test harness | vitest in `packages/shared`, `apps/worker`, `apps/web`; `pnpm test` at the root; throwaway Postgres per run; mock Redis/SMTP/embeddings; scripted Agent SDK mock (`runner/mock-sdk.ts`) behind a swappable `query()` (`runner/sdk.ts`); any network call fails a test | `*/test/`, `packages/db/src/testing.ts` |
| 0.1 Fix found by the tests | Approval execution was not idempotent under concurrency (5 parallel executions sent the email more than once). Now claimed `APPROVED → EXECUTING` before running: at most once | `apps/worker/src/runner/approvals.ts` |
| 0.1 Refactor | Taint/leak override is one pure function `applyRunSignals()` used by both gate paths | `packages/shared/src/index.ts` |
| 0.2 SSRF | `safeFetch`: own DNS resolution, every record must be public, socket pinned to the validated IP, manual redirects (max 5) re-validated per hop, http(s) only, no URL credentials, size and time caps. `web_fetch` uses it | `packages/shared/src/netguard.ts` |
| 0.3 2FA | TOTP (RFC 6238, replay-protected), QR enrollment, 10 hashed single-use recovery codes, password + code re-auth to disable/regenerate, mandatory for Owner/Admin via workspace setting (default on), forced `/setup-2fa`, lockout 5 failures → 15 min with "try again at <time>", Google sign-in goes through the same checks, step-up re-auth cookie for Phase 1.1, owner CLI `unlock` / `reset-2fa` | `apps/web/src/lib/server/twofactor.ts`, `apps/web/src/app/api/{auth/login,me/2fa,me/reauth}`, `packages/db/src/cli.ts` |
| 0.4 Claude credentials | Per-workspace encrypted credential (`oauth` or `api_key`), resolved for every run; instance env as optional fallback (`CLAUDE_INSTANCE_FALLBACK`); agent env is an explicit allow-list with only that credential; per-workspace agent HOME; Owner-only API/UI showing type + last 4 | `packages/db/src/claude.ts`, `apps/worker/src/lib/env.ts`, `apps/web/src/app/api/settings/claude` |
| 0.5 i18n | next-intl, id + en, 805 keys per language, per-user/workspace/browser locale, localized server errors, locale-aware dates/numbers/money (`Rp 1.234.567`), employee output language in the system prompt, bilingual notifications/invoice email/PDF, i18n lint test | `apps/web/src/i18n`, `apps/web/messages`, `packages/shared/src/messages.ts` |
| Lint | ESLint (typescript-eslint recommended + react-hooks) as `pnpm lint`; there was none before | `eslint.config.js` |

Migrations added: `0003_two_factor.sql`, `0004_locale.sql` (additive, `IF NOT EXISTS`).

## How it was verified

- `pnpm -r typecheck`: green (5 packages).
- `pnpm test`: **shared 195, web 32, worker 40 = 267 tests, all passing.** Highlights:
  - `classifyTool` for every builtin, `mcp__` names, overrides, fail-closed unknowns; the full 32-case
    `decideGate` matrix (4 autonomy × reversible/irreversible × dry run × allow-list match) plus grants/overrides.
  - Taint forces approval for an allow-listed email (platform tool) and an allow-listed external MCP tool; leaks
    force approval; the final answer is redacted.
  - Approvals: executes the edited payload; idempotent sequentially and under 5× concurrency (this test failed
    against the old code, verified); never executes PENDING/REJECTED, cancelled-task, dry-run or kill-switch cases.
  - Kill switch: blocks new runs (SDK never started), aborts an in-flight run in < 3 s and cancels the task, only
    the affected workspace.
  - Budgets: a run stops at the first step over the cap (the following email is never attempted); daily and monthly
    caps refuse to start a run; the employee is paused.
  - Audit log: UPDATE, DELETE, TRUNCATE (and a zero-row UPDATE) rejected by the trigger on a real database.
  - SSRF: decimal/hex/octal/short IPv4, `[::ffff:127.0.0.1]`, `[::1]`, metadata IP, `0.0.0.0`, a name resolving
    to 10.x, mixed public/private answers, `localhost`, non-http schemes, redirects to 169.254.169.254 / to a 10.x
    host / to IPv4-mapped loopback, >5 redirects, DNS rebinding (the second lookup is never made), size and time caps.
    Blocked cases prove that no TCP connection was opened.
  - 2FA via the real route handlers: password alone gives no session; wrong/replayed codes rejected; recovery
    code works once; lockout after 5 password or code failures, even the right password refused while locked;
    enrollment enforced for Admin/Owner only when the setting is on; disable needs password + code and is refused
    while required; step-up required and granted.
  - Credentials: a run's env contains only its own workspace's token; the exact env key set is asserted;
    no platform secret appears; fallback only while enabled; DB rows never contain the secret; API never returns it,
    Admin can read status but not change it.
  - i18n lint: no hard-coded UI strings, all keys exist, id/en identical keys and placeholders, every `HttpError`
    has a translated code. Formatter tests for `Rp 1.234.567`, dates in Asia/Jakarta, relative time.
- `pnpm lint`: green.
- Runtime smoke (dev DB, `next dev` on 127.0.0.1:3110, memory-capped, stopped afterwards): `/login` and `/signup`
  render in `id`/`en` from `Accept-Language`. After sign-in, all 12 app pages return 200 with no i18n errors in the log,
  and API errors come back in Indonesian (`Tugas tidak ditemukan.`).
- The production-target guard was exercised with the real production env file: refuses the production
  `DATABASE_URL`, and refuses a missing namespace.

## Known limits

- **2FA default ON affects production after its migration**: the existing Owner will be asked to enroll at the next
  sign-in. This is intended (the brief makes it mandatory), but the Owner should know before migrating.
- **`CLAUDE_INSTANCE_FALLBACK` defaults to `true`** so production keeps running unchanged. Turn it off once every
  workspace has its own credential, before allowing other people to sign up.
- Lockout can be abused to keep a known account locked (15 min at a time); the CLI clears it. The lockout
  response also reveals that an account exists for that email (the same is true of most lockout designs).
- No `next build` was run on this host (RAM). The dev-server smoke covers rendering; the production build should be run
  where at least 1.5 GB is free (or on the fresh VM in Phase 4).
- Some content stays in the language it was written in: role templates (`@wfos/templates`), tool descriptions
  sent to the model, audit action identifiers and step names in the inspector (technical identifiers).
  Template content becomes bilingual in Phase 3.4.
- Workspace time zone: one instance-wide `APP_TIME_ZONE` for now; Phase 3.6 needs per-workspace time zones.
- Rate limits for 2FA use Redis counters; the per-account lockout is in Postgres (see DECISIONS D8).

## For the owner when deploying Phase 0 to production (not done by the agent)

1. Read DECISIONS D2, D7, D11, D13.
2. `git pull` the branch in the production checkout, `pnpm install --frozen-lockfile`, `pnpm db:migrate`
   (adds 0003, 0004), `pnpm build` (needs ~1.2 GB free), `pm2 reload wfos-web wfos-worker`.
3. Sign in, set up 2FA, optionally move the Claude token from `.env` into Settings → Claude credential and set
   `CLAUDE_INSTANCE_FALLBACK=false`.
