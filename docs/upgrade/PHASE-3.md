# Phase 3 — Live office, Telegram, PWA, departments, PRD handoff, client project health

## What changed

| Item | Where |
|---|---|
| **3.1 Live office.** Pure model, unit-tested: layout from the real employee list (rooms per team/department, a lounge sized to the headcount, wrapping rows); state → activity (task status, last tool step, stale step → thinking); activity → animation (desk/bookshelf/rack/lounge/coffee, pose, `!`/`…`/`zz`); standing spots and walking | `packages/shared/src/office.ts` |
| Snapshot API (employee, team names, current task title, last step kind and name; no step input or output), patched live from SSE | `apps/web/src/app/api/office`, `components/office/use-office.ts` |
| 2D canvas, the default: 60 fps while visible, stops when the tab is hidden, `prefers-reduced-motion` (no walking, bobbing or blinking; redraw on change), hover and click a character to open its task, fits the width or scrolls on phones | `components/office/office-2d.tsx` |
| 3D low-poly view (three.js), loaded only when chosen; same model; falls back to 2D without WebGL | `components/office/office-3d.tsx` |
| `/office` page: 2D/3D toggle (remembered per browser), live status, legend, an accessible summary plus a "who is doing what" list of links | `app/(app)/office/page.tsx` |
| **3.2 Telegram.** Link a chat with a one-time code (hashed, 10 min). The webhook accepts only requests carrying the secret header, and links from private chats only | `api/me/telegram`, `api/telegram/webhook`, migration `0010_telegram.sql` |
| Approve/Reject buttons: HMAC-signed `callback_data`, single use, bound to the linked user, Admin role re-checked at press time, the pair voided after use. The decision runs through the same `decideApproval()` as the web | `lib/server/approvals.ts`, `packages/shared/src/telegram.ts` |
| Worker sends to linked members: done / failed / approval (buttons for Admin+ only), plus a daily summary once per workspace per day at `TELEGRAM_SUMMARY_HOUR` | `apps/worker/src/lib/telegram.ts`, `lib/notify.ts` |
| **3.3 PWA.** Manifest, icons (192/512/maskable/apple), service worker with an offline page; pages and API data are never cached | `app/manifest.ts`, `public/sw.js`, `public/offline.html`, `public/icons` |
| Web Push: VAPID (worker only), per-device subscriptions limited to the browsers' push services (checked on subscribe and at send), gone endpoints removed, Account card | `api/me/push`, `apps/worker/src/lib/push.ts`, `packages/shared/src/push.ts`, migration `0011_web_push.sql` |
| **3.4 Departments.** Developer (Workspace mode, backend/frontend/qa subagents), Project, Finance, Marketing; bilingual SOPs and subagents, editable in Settings → Departments; SOP and subagents go into the employee's run | `packages/templates/src/departments.ts`, `packages/db/src/departments.ts`, migration `0008` |
| **3.5 PRD handoff.** `draft_document` kind `prd` → `handoff_prd` approval. The owner can request changes, or change the developer or repository but not the PRD text. Approving creates a linked Developer task carrying the PRD | `tools/registry.ts`, `tools/actions.ts`, migration `0009` |
| **3.6 Client project health.** Project deadline and progress; late / at risk / on track, computed in the workspace time zone; shown per client | `packages/shared/src/health.ts`, `api/clients`, migration `0007` |

## How it was verified

`pnpm -r typecheck` ✔, `pnpm lint` ✔, `pnpm test` ✔ (shared 448, web 57, worker 68), `pnpm test:system` ✔ (29, unchanged
sandbox). Migrations 0007–0011 were applied to the **dev** database only; the production database has none of them.

- **Office:** `packages/shared/test/office.test.ts` (38):
  - tool → activity for every built-in tool, MCP prefixes and unknown tools;
  - state → activity (paused, idle, awaiting approval, fresh/stale steps, LLM steps);
  - activity → animation, including idle rotation that is stable within a period and varies across it;
  - layout for 0/1/2/7/30/100 employees with no overlapping rooms or desks, desks inside their room and below the shelf strip, a seat for everyone;
  - team/department/general rooms, deterministic and order-independent, wrapping into rows;
  - spots inside the right room, movement speed and arrival, list order.
  `apps/web/test/office.test.ts`: the snapshot contains only this workspace's non-archived employees, team rooms, the current task and last step, and no step input/output.
  Visual check: the 2D view (30 employees; light, dark, phone width) and the 3D view (software WebGL) rendered in headless Chromium from a static harness. No Next build or dev server ran on this 2 GB host.
- **Telegram:** `apps/web/test/telegram.test.ts` (8):
  - a wrong or missing secret gets 401;
  - a link code works once, from private chats only, and expired codes are refused;
  - an Admin's button approves once and a second press does nothing; pressing one button voids the other;
  - another user's press is refused without burning the button;
  - a demoted user is refused; expired or tampered signatures are refused.
  `apps/worker/test/telegram.test.ts` (4): buttons only to linked Admin/Owner, rows bound to user and approval, `callback_data` ≤ 64 bytes, plain notifications carry no buttons, nothing is sent without a token, and the daily summary goes out once, at the configured hour.
- **Push:**
  - `packages/shared/test/push.test.ts` (17): allow-listed push hosts only; http, ports, credentials, IPs, localhost and suffix tricks are refused; links stay in-app.
  - `apps/web/test/push.test.ts`: only the public key is exposed; non-push endpoints such as Redis or cloud metadata get 400; users delete only their own subscriptions; a new sign-in takes the endpoint over; the manifest is installable.
  - `apps/worker/test/push.test.ts`: fan-out reaches the workspace's members only, stored non-allowed endpoints are skipped, 410 removes the subscription, and nothing is sent without VAPID keys.
- **Departments, handoff and health:** `apps/worker/test/departments.test.ts`, `handoff.test.ts`, `apps/web/test/handoff-decide.test.ts`, `project-health.test.ts`, `packages/shared/test/health.test.ts`.
- All transports in tests are mocks (`setTelegramFetch`, `setPushSender`); no test reaches Telegram, a push service or the internet.
- Also fixed: a timing flake in `apps/worker/test/limits.test.ts`, where fixture reset times were built from the current second.

## For the owner (not done here)

- Production migration (0007–0011) after review.
- Telegram: create the bot, set `TELEGRAM_*`, then register the webhook (command in `.env.example`). Nginx must pass `/api/telegram/webhook`.
- Web Push: generate VAPID keys (`pnpm --filter @wfos/worker exec web-push generate-vapid-keys`) and set `VAPID_*`.
- New dependencies: `web-push` (worker), `three` (web, loaded only by the 3D view).

## Known limits

- The office follows the **last recorded step**. Tool steps are recorded when the tool finishes (Workspace-mode permission steps when it starts), so the view can trail the real action by one tool call (D26).
- The office's 60 fps target with 30 employees was not measured on a mid-range laptop here (there is no GPU or browser on this host besides the headless check). The 2D view draws about 200 primitives per frame, and the loop stops when the tab is hidden.
- Telegram: one bot per installation; Edit & Approve stays web-only.
- Push on iOS needs the app added to the Home Screen first (Safari limitation); the Account card says so.
