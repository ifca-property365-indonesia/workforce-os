# Phase 2 — Claude subscription limit meter

## What changed

| Item | Where |
|---|---|
| Event shape verified against the installed SDK (`SDKRateLimitEvent`, SDK 0.3.292); normaliser for `resetsAt` (s/ms) and `utilization` (fraction/%), 70/90 % threshold logic | `packages/shared/src/limits.ts` |
| `claude_limits` table: latest value per workspace × credential source × window; `workspaces.quota_paused_until/quota_pause_reason` (migration `0006_claude_limits.sql`) | `packages/db` |
| Executor handles `rate_limit_event` (subscription credentials only): store, SSE `limits.updated`, warnings once per window (`limits.warning` + notification, bilingual), `rejected` → stop the run, pause the queue, notify | `apps/worker/src/lib/limits.ts`, `runner/executor.ts` |
| Paused workspace: tasks are held without starting the agent and re-queued for the reset; interrupted tasks go back to QUEUED (resumable, same session in Workspace mode); pause cleared automatically after the reset | `runner/task.ts`, `runner/chat.ts` |
| `/api/limits` (meter only for oauth; USD equivalent as secondary), `/api/limits/resume` (Admin, resume by hand) | `apps/web/src/app/api/limits` |
| Dashboard widget with bars (5-hour, weekly, per-model weekly), % used, "resets <local time>", live over SSE; PAUSED_QUOTA banner with reason and resume button; toasts for warnings/pause | `components/inspector/limits-card.tsx`, app shell |

## How it was verified

`pnpm -r typecheck` ✔, `pnpm lint` ✔, `pnpm test` ✔ (shared 386, web 41, worker 51). The system suite from Phase 1 is unaffected
(Phase 2 only changes the worker's message loop).

- `packages/shared/test/limits.test.ts`: normalisation (seconds/ms, fraction/percent, missing fields), thresholds.
- `apps/worker/test/limits.test.ts` drives the runner with **recorded-shape fixture events**
  (`test/fixtures/rate-limit-events.json`): values stored per window; warnings at 72 % and 91 % exactly once, not repeated
  in the same window, repeated in a new window, and in the workspace language; API-key workspaces ignored; `rejected`
  stops the run before the next tool call, pauses the queue until `resetsAt`, re-queues the task, holds other tasks
  without starting the agent, and resumes them after the reset.
- `apps/web/test/limits.test.ts`: windows only for subscription credentials (5-hour first); pause reported; Admin-only
  manual resume restarts exactly the held tasks.

## Known limits

- The meter shows what the SDK last reported; it updates only while agents run (no polling of Anthropic).
- Workspaces sharing the instance fallback credential are paused individually as each hits the limit (D23).
- `overage*` fields of the event are stored nowhere yet; the meter shows the plan windows only.
