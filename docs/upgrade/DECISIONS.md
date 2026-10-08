# Upgrade v2 — decisions log

Each entry: the decision, why, and the alternative that was rejected.

## D1. Work in a separate worktree, never in the production checkout
Production (`wfos-worker`) runs `tsx src/index.ts` straight from `/root/apps/workforce-os`, so any checkout or
`pnpm install` there would change what production loads on its next restart. All work happens in the worktree
`/root/apps/workforce-os-v2` (branch `upgrade/v2`) with its own `node_modules` and `.env`.
Rejected: switching branches in the main checkout.

## D2. Dev/test isolation: own database, own Redis index, own namespace, enforced at startup
Dev uses database `workforce_os_dev` (role `workforce_dev`, `CREATEDB` so tests can create throwaway databases),
Redis DB 13 and `WFOS_NAMESPACE=wfos-dev`. Redis pub/sub channels are global across DB indexes, so the namespace
prefixes both the BullMQ keys (`prefix`) and the event/control channels. Without it, a dev kill switch could
reach production runs and a dev worker could consume production jobs.
`assertNotProductionTarget()` (`packages/shared/src/runtime.ts`) runs in the worker, web, migrate and seed
entry points. It is active only when `WFOS_ENV=development|test`, so production boots unchanged. It refuses to start
when `DATABASE_URL`/`REDIS_URL`/namespace match the production env file.
Rejected: relying on a different Redis DB index alone (pub/sub leaks across indexes); enabling the guard by
default (it would need to know which instance is "production", and a mistake there would stop production).

## D3. Taint/leak override is one pure function
`applyRunSignals()` in `@wfos/shared` is used by both the platform tool path (`registry.ts`) and the external
MCP path (`executor.ts`), so "taint forces approval" cannot drift between them and is unit-tested once.

## D4. Approved actions run at most once (new status EXECUTING)
`executeApproval` used to read `APPROVED`, run the action and only then mark it `EXECUTED`. Two concurrent jobs, or
a retry after a crash, could therefore send the same email twice. A test showed 5 parallel calls sending more than
once. The executor now claims the row first (`APPROVED → EXECUTING`, conditional UPDATE … RETURNING). If the
process dies mid-action, the approval stays `EXECUTING` and is not retried automatically, because for
irreversible actions "maybe not sent" needs a human, never a blind retry.
Rejected: relying on the BullMQ jobId for dedupe (does not cover retries after a crash).

## D5. Worker tests use a real throwaway Postgres and mocked transports
`apps/worker/test/global-setup.ts` clones `workforce_os_test_<pid>_<ts>` from the template
`workforce_os_test_template` (pgvector is not a trusted extension, so a non-superuser role cannot create it in
a fresh database), migrates it, and drops it at the end. Redis, SMTP and embeddings are replaced with in-memory mocks,
`fetch` is stubbed to fail, and any attempted network call fails the test. The Agent SDK is swapped through
`runner/sdk.ts` for the scripted `runner/mock-sdk.ts`. The suites never skip: no `TEST_DATABASE_ADMIN_URL`, no run.
Rejected: testcontainers (no Docker on the host); mocking the database (the audit trigger and the approval claim
are database behaviour and must be tested against Postgres).
