# Workforce OS

A self-hosted platform for "hiring" AI employees. Each employee is a named agent with a role, persona, business context, persistent memory, scoped tool access and an explicit autonomy level. Employees take work from chat, the task board or scheduled routines, and they can work together in teams. Any irreversible action stops at a human approval. Every step is metered, can be inspected, and can be rehearsed in a dry run.

Agents run on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). The SDK's built-in tools (Bash, file I/O, web) are **disabled**. Employees can only use the platform's own MCP tools, plus external MCP servers that an Owner connects. Work can also arrive from outside: inbound webhooks, and machine clients (Claude Code, Claude Desktop) through the platform's own MCP server.

```
apps/web        Next.js 16 (App Router) UI + route handlers (Zod), SSE at /api/events
apps/worker     BullMQ consumers: agent runner, approvals executor, ingest, scheduler, replay, demo
packages/db     Drizzle schema + migrations + seed (PostgreSQL + pgvector)
packages/shared Types, Zod schemas, task state machine, tool registry + gate, guards, crypto, mail, invoice PDF
packages/templates  Role templates (Developer, PM, Finance, Support, Sales, Researcher)
```

## How the safety model works ("where the work stops")

| Layer | Where it is enforced |
|---|---|
| Tool classification (reversible / irreversible) | `packages/shared/src/index.ts` → `BUILTIN_TOOLS`, `classifyTool()`. Unknown external tools are classified by verb (camelCase split; send/pay/delete/… anywhere is irreversible; a leading read verb is a read; chained names like `fetch_and_release_funds` and anything unsure fail closed = irreversible) |
| Gate (DRAFT / QUEUE / EXECUTE / CLOSE, per-tool override, Owner allow-list) | `decideGate()`, called by **every tool handler** in `apps/worker/src/tools/registry.ts`; external MCP tools go through `canUseTool` in `runner/executor.ts`. Permissions can target one MCP tool or a glob (`mcp:crm:list_*`); a disabled rule always wins. Every decision is recorded with the rule that produced it |
| Per-action approval | each irreversible call creates its own `approvals` row with the exact payload; nothing runs until a human approves it, and the approved (or edited) payload is what gets executed |
| Guards (on by default) | input: prompt-injection screening of tool results (external MCP results too, capped at 8 000 characters), which **taints** the run so even allow-listed actions need approval. Output: secret/PII leakage check on payloads and answers (`guards/content.ts`) |
| Taint follows the content | untrusted input stays untrusted when it is stored: webhook payloads and machine-client messages start tainted; tasks created by a tainted run (create_task, delegation, handoff, retries, reruns), memories, messages between employees, chat replies, routines and skills carry the mark, and a run that reads them is tainted too. Stored untrusted text is fenced as data in prompts |
| Run safety | an idle watchdog stops a run with no activity for `RUN_IDLE_TIMEOUT_MIN` (default 20; a long tool call pauses it up to 3×), and a repeat guard refuses the same tool call made several times in a row and then stops the loop (`runner/executor.ts`) |
| Budgets | per-employee daily and per-workspace monthly caps are checked before each run and after every LLM step, with an SDK `maxBudgetUsd` backstop. Hitting a cap sets the employee to `PAUSED_BUDGET` |
| Kill switch | sets a DB flag, Redis pub/sub aborts every in-flight run immediately, queued work is held, and approvals cannot execute |
| Audit | `audit_log` is append-only (a Postgres trigger blocks UPDATE/DELETE/TRUNCATE) |
| Approval execution | an approved action is claimed (`APPROVED → EXECUTING`) before it runs, so concurrent or retried jobs execute it at most once |
| Web fetch | `safeFetch` (`packages/shared/src/netguard.ts`) resolves DNS itself, refuses non-public addresses (private, loopback, link-local/metadata, CGNAT, ULA, IPv4-mapped), pins the socket to the checked IP and re-checks every redirect. MCP OAuth discovery/token requests, MCP tool listing and imported MCP slots use `assertPublicUrl` (only the host an Owner configured is exempt) and refuse cross-origin redirects |
| Credentials | AES-256-GCM (`ENCRYPTION_KEY`). They are never returned to the browser or given to the model. The agent process gets an allow-listed env with only its own workspace's Claude credential |

Run `pnpm --filter @wfos/worker exec tsx src/scripts/safety-check.ts <workspaceId>` to check the gate against a real DB and SMTP. It needs no Claude token.

## Credits & pricing

1 credit = $0.01. Settings → Pricing publishes the credits per model per 1K tokens (input, output, cache read, cache write) and per tool call, and includes a cost forecaster. Every LLM step is charged from that table and shows up in the task's Activity Inspector.

## Claude authentication

Each workspace stores its own Claude credential: **Settings → Claude credential** (Owner only). It is either a Claude subscription token (create one with `claude setup-token`) or an Anthropic API key. It is encrypted with AES-256-GCM, and the UI only ever shows its type and last 4 characters. A run receives only the credential of its own workspace, only while it runs.

The instance env credential is an optional **fallback** for workspaces without their own: `CLAUDE_AUTH_MODE=oauth` uses `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_AUTH_MODE=api_key` uses `ANTHROPIC_API_KEY`. Set `CLAUDE_INSTANCE_FALLBACK=false` to require every workspace to bring its own (recommended as soon as other people can sign up).

Without a credential, runs fail with a clear message. **Demo Mode** (Settings, or "Run scripted demo" on the Dashboard) needs no token and makes no network calls.

Check a credential end to end:
`pnpm --filter @wfos/worker exec tsx src/scripts/sdk-smoke.ts <employeeId> "Reply with exactly: pong"`

## Deploy natively with PM2 (this is how workforce-os.property365.co.id runs)

**Step by step from a fresh VPS, including backups, upgrades and key rotation: [docs/DEPLOY.md](docs/DEPLOY.md).**

Requires Ubuntu 24.04 or 26.04, Node 24, pnpm 10, PostgreSQL with pgvector (16 on 24.04, 18 on 26.04), Redis 7 (set `maxmemory-policy noeviction`), and Nginx.

```bash
cp .env.example .env              # fill DATABASE_URL, ENCRYPTION_KEY, AUTH_SECRET, APP_URL, Claude credential
pnpm install
pnpm db:migrate && pnpm db:seed   # model prices; SEED_DEMO=true adds a demo owner + 3 employees, 1 team, 2 clients, 1 routine
pnpm build                         # Next.js build (≈1.2 GB RAM peak)
pm2 start ecosystem.config.cjs && pm2 save
sed 's/${DOMAIN}/<domain>/g' nginx/native.conf.template | sudo tee /etc/nginx/sites-available/workforce-os >/dev/null
sudo ln -sf ../sites-available/workforce-os /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <domain> --redirect   # deploy/setup-ubuntu.sh --domain does these three steps for you
```

The first account is created by signing up (always allowed for the first user). With `SEED_DEMO=true` the seed also creates a demo owner (`SEED_OWNER_EMAIL`, default `owner@workforce.local`) with a random password that is printed once and must be changed at first login, or with `SEED_OWNER_PASSWORD` if you set one. No account with a known password is ever created by default.

### Backups

`deploy/backup.sh` writes a verified `pg_dump`, the uploaded files, the git mirrors, a copy of `.env` and a checksum manifest to `/root/backups/workforce-os` and keeps 14 days. Keep the `.env` copy, because stored credentials can only be decrypted with its `ENCRYPTION_KEY`. Schedule it with cron:

```
30 2 * * * /root/apps/workforce-os/deploy/backup.sh >> /var/log/workforce-os-backup.log 2>&1
```

The backups sit on the same disk. Copy them off the server too (rclone, S3, or another VPS). Restore with `deploy/restore.sh` (docs/DEPLOY.md → Backups); `pnpm test:deploy` proves the round trip. Upgrade with `deploy/upgrade.sh` (backup, migrations, build, reload, health check, automatic rollback).

### Logs

`pm2 install pm2-logrotate`, then `pm2 set pm2-logrotate:max_size 10M` and `pm2 set pm2-logrotate:retain 7`.

## Accounts & sign-in security

- Admins add people in **Settings → Members**. New accounts get a one-time temporary password, and the user has to pick their own at first sign-in (`/change-password`). Until they do, every other page and API is blocked.
- **Account** (avatar menu, top right, or your name in the sidebar) edits your display name and changes your password. A password change signs out every other session.
- Admins can **reset** a member's password (new temporary password, old sessions revoked) and **remove** members. Only Owners can act on Owners, and a workspace always keeps at least one Owner. A password reset is refused when the user also belongs to another workspace.
- **Two-factor authentication (TOTP)**: Account → Two-factor authentication (QR enrollment, 10 single-use recovery codes, password + code to turn it off). It is **mandatory for Owners and Admins** while the workspace setting is on (default on; Settings → General → Safety, Owner only). They are sent to `/setup-2fa` at sign-in until they enroll.
- **Lockout**: 5 failed password or code attempts lock the account for 15 minutes ("try again at <time>"). Google sign-in goes through the same lockout and 2FA step.
- **Owner CLI** (on the server): `pnpm --filter @wfos/db cli unlock <email>` clears a lockout; `pnpm --filter @wfos/db cli reset-2fa <email>` turns 2FA off for a user who lost their authenticator and recovery codes. Both are written to the audit log.
- Login is limited to 10 attempts per account and 30 per IP every 15 minutes, and signup to 5 per IP per hour. Behind Cloudflare, Nginx has to resolve the real visitor IP (`set_real_ip_from` + `real_ip_header CF-Connecting-IP`, include `nginx/cloudflare-realip.conf`) and pass it as `X-Real-IP`. Without that, every visitor shares Cloudflare's IPs.

## Deploy with Docker Compose (fresh Ubuntu VPS)

```bash
curl -fsSL https://get.docker.com | sh
git clone <repo> workforce-os && cd workforce-os
cp .env.example .env   # set DOMAIN, POSTGRES_PASSWORD, ENCRYPTION_KEY, AUTH_SECRET, APP_URL=https://$DOMAIN
./deploy/init-letsencrypt.sh you@example.com   # issues the Let's Encrypt cert (DNS A record must point here)
docker compose up -d --build
```

Compose runs `postgres` (pgvector), `redis`, `migrate` (migrations + price seed, runs once per start), `web`, `worker`, `nginx` (SSE-safe proxy) and `certbot` (renews every 12 hours). Uploaded files and the local embedding model live in the `storage` volume.

## Claude subscription meter

For workspaces running on a Claude subscription (`oauth` credential), the dashboard shows the 5-hour and weekly windows (plus per-model weekly windows when reported) with % used and the local reset time. It updates live from the Agent SDK's `rate_limit_event`. Warnings go out at 70% and 90% (in-app and as notifications). When the subscription **rejects** a request, the run stops, the workspace queue is paused (**PAUSED_QUOTA**, with the reason in a banner), and tasks resume automatically after the reset. Admins can also resume by hand. API-key workspaces keep the credit/USD meter, and the USD-equivalent cost is always shown as a secondary number.

## Workspace mode (Claude Code in a sandbox)

An employee runs in **Tool mode** (platform tools only, the default) or **Workspace mode**: Claude Code with Bash, files, git, subagents and skills, inside an isolated sandbox per task. Switching to Workspace mode (or widening its network allow-list) needs an Owner/Admin and a fresh password + 2FA confirmation. The Developer template defaults to it.

- **Isolation** (native install only): every run is a transient systemd unit with its own dynamic UID, its own network namespace, a read-only system, no `/root`/`/home`, a private `/tmp`, an invisible `/proc` and memory/CPU/task/time limits. Postgres, Redis, the web app and the internet are unreachable. The only ways out are Unix sockets to the platform: the Anthropic API gateway, the egress proxy (per-employee host allow-list, HTTPS only) and the control channel. The sandbox never holds platform secrets or the Claude credential (the gateway injects it). Proof: `pnpm test:system` (root + systemd) and `docs/upgrade/SPIKE-sandbox.md`.
- **Bash**: every command is parsed and classified. Local, reversible work (read, build, test, lint, local git) runs. Network, installs, publishing, writes outside the workspace, git config/hooks, inline interpreter code, secret reads and anything unknown become an approval card with the exact command. When approved, the platform runs exactly that command in the same sandbox and the employee continues with its output. After untrusted content was read, only read-only commands run unattended.
- **Code delivery**: connect repositories in **Settings → Repositories** (the token stays with the platform). A task gets a checkout on `agent/<task-id>`. The employee commits locally, and `git_push` / `create_pull_request` are approvals. The task's **Code** tab shows the diff and the last test run, with **Approve & push**, **Request changes** (resumes the same session) and **Discard**.
- **Resources**: `WORKSPACE_CONCURRENCY` (default 1; a further sandbox also needs free memory, see `WORKSPACE_MEMORY_RESERVE_MB`), `WORKSPACE_MEMORY_MAX_MB` (2048), `WORKSPACE_TASK_MAX_HOURS` (8 h of sandbox time per task across its runs), `WORKSPACE_SLICE_MIN` (60: after this a run hands its sandbox to a waiting task and resumes later), `WORKSPACE_RETENTION_DAYS` (14; deliverables are kept). One Claude Code process needs about 300 MB at start (measured). A run with no activity is stopped after `RUN_IDLE_TIMEOUT_MIN`.
- **Toolchain** for documents and code (LibreOffice, pandoc, poppler, qpdf, tesseract eng+ind, Python document libraries): `deploy/setup-ubuntu.sh --toolchain`. Built-in skills for docx/xlsx/pptx/pdf are seeded into each new workspace.
- Workspace mode is not available in the Docker Compose deployment yet (it fails closed there; Tool mode works).

## Live office

**Office** (`/office`) shows every employee as a character whose behaviour follows live work:
- typing at the desk while writing or editing;
- at the bookshelf while reading or searching;
- at the server rack while running commands;
- standing with **!** while an approval waits;
- "…" while thinking, asleep when paused;
- in the lounge, at the coffee machine or chatting when idle.

Teams and departments get their own rooms, generated from the actual employee list. The 2D view is the default; the low-poly 3D view (three.js) loads only when chosen, with CC0 furniture from Kenney and KayKit in `apps/web/public/office` (≈100 KB gzipped; sources and licences in its README). A reception at the front carries the workspace name and initials. Every employee's character (skin, hair, beard, glasses, headwear, shirt, company badge) is set in the character editor on the employee page; without one, a look is derived from the id. Clicking a character opens its task. The page lists "who is doing what" as text, respects `prefers-reduced-motion`, and stops rendering while the tab is hidden.

## Departments and PRD handoff

Each workspace has **Developer** (Workspace mode with backend/frontend/qa subagents), **Project**, **Finance** and **Marketing** departments. Each has bilingual SOP instructions and subagent definitions, editable in **Settings → Departments**. An employee's department adds its SOP to the instructions, and in Workspace mode its subagents too.

A Project employee can draft a **PRD** (`draft_document` with kind `prd`). It becomes a `handoff_prd` approval:
- the owner reviews it, can request changes, or pick another developer or repository (never edit the approved text);
- approving creates a linked Developer task carrying the PRD as context.

## Client project health

Projects have a deadline and progress. The Clients page shows each project as:
- **late**: past the deadline and not done;
- **at risk**: deadline in under 14 days with progress below 70%, or no activity for 7 days;
- **on track**: otherwise.

All date math uses the workspace time zone (`APP_TIME_ZONE`).

## Telegram and push notifications

- **Telegram** (optional, `TELEGRAM_*`):
  - Each user links their own chat under **Account → Telegram**, with a one-time code sent to the bot as `/link CODE`.
  - Linked members get done/failed/approval notifications and a daily summary.
  - Admins and Owners also get **Approve / Reject** buttons. Each button is HMAC-signed, works once, only for the user it was sent to, and only while that user still has the Admin role. The decision goes through the same checks and audit log as the web (`via: telegram`). Proposed routines and skills have no buttons: they are approved in the web, where the full content is shown.
  - Register the webhook yourself after deploy; the command is in `.env.example`.
- **Preferences**: **Account → Notifications** switches each kind (approval, task done/failed, incident, routine failed, limits, chat reply) per channel (in-app, email, Telegram, push) and mutes employees. Read state is per user. "Task finished" is only sent when the task has a result.
- **Web push** (optional, `VAPID_*`):
  - The app is installable (manifest, icons, offline page).
  - **Account → Push notifications** turns push on per device.
  - The service worker never caches pages or API data.
  - Push endpoints are limited to the browsers' push services.
  - A focused app window acknowledges a push and shows it as a toast instead of a second system notification.

## Languages

The UI is available in **Bahasa Indonesia** and **English**. Each user picks a language (account menu or Account page), the workspace has a default (Settings → General), and otherwise the browser language is used. Dates, numbers and money follow the language (`Rp 1.234.567` in Indonesian) in `APP_TIME_ZONE` (default `Asia/Jakarta`). Each employee has an **output language** (workspace default / Bahasa Indonesia / English) for answers, documents and emails. Notifications, default invoice emails and invoice PDFs use the workspace language. Conventions for contributors: `docs/upgrade/I18N.md`. `apps/web/messages/id/.source-hashes.json` records which English text each Indonesian string was translated from; the i18n test fails on stale or missing translations (`pnpm --filter @wfos/web i18n:rehash` after updating them).

## Teams and chat

- **Who answers in a team chat**: each team has a responder mode (Teams page): **Lead** (default), **Everyone** (members answer in turn, each seeing the earlier replies), **Mentions only**, or **Automatic** (Claude Haiku 5.5 picks the teammate in under 5 s, shown as "Picked automatically · 94%"; on a timeout, an error or low confidence the lead answers). `@Name` and `@semua`/`@everyone` override the mode. At most 5 employees answer one message.
- **Approvals in the thread**: an approval raised in chat appears as a card under the reply that raised it (guard findings included); Admins decide there or in `/approvals`, others see "waiting for an admin". After the decision a one-line receipt is posted in the conversation. Irreversible actions that ran through the allow-list show as chips.
- **Versions**: a conversation is a tree. **Edit** a message or **Regenerate** a reply to fork a version (switcher "‹ 2/3 ›"); an edit stops the old reply, and pending approvals on the abandoned branch expire. Messages sent quickly one after another are answered as one turn.
- **Proposing routines and skills**: an employee can propose a routine (`propose_routine`) or a skill (`skill_propose`) in chat; it becomes an approval card showing the rule and next three runs, or the full skill text.

## Incidents and recovery

A task that fails, stalls, loops or cannot start, or a routine run that fails, opens an **incident** (Dashboard card, Inspector). For a team subtask the lead gets it in its review (as data, never as instructions) and may `retry_subtask` or `reassign_subtask` at most twice per piece of work; otherwise a person is notified once. More than 5 incidents per workspace per hour are muted. A reaper fails runs that died, wakes leads whose subtasks all ended, resumes tasks whose approvals were all decided and re-queues lost work.

## Needs a decision and Ctrl+K

- **Needs a decision** (`/approvals`, the menu bar and dock count): everything that waits for a person in one place. Approval cards (with their exact payload) first; then incidents a person was asked to handle or that no lead is handling (Retry, Close), tasks an employee proposed that wait to be started (Start, Cancel), employees paused because their budget ran out, and finished agent work that is not in its repository's default branch yet or whose merge failed (Review & merge). One endpoint, `GET /api/inbox`, scoped to the workspace; viewers see it, members and up act on it.
- **Ctrl/⌘ K** (desktop and classic layout): search pages, tasks, employees, divisions, clients, apps and documents of the workspace, or start a new task with what was typed. Tasks use Postgres full-text search (prefix words, `simple` configuration) on a GIN index (migration 0033); the small tables match names. `GET /api/search?q=`.

## App tests and test accounts

- **Test accounts (C10)**: an app with a sign-in adds `"testUsers": "<command>"` to wfos-app.json. On every PREVIEW release (never live) the command runs after the migration with the shared password in `$WFOS_TEST_PASSWORD` and prints its accounts per role (+ TOTP keys) as one JSON line; they are stored encrypted (Apps → the app → Test accounts). Admins can show a password and the current 2FA code (audited). Needs wfos-app-helper v5 on the app server (older helpers skip it with a warning).
- **Browser tests (C3)**: Apps → the app → App tests → Test the app starts a task for a tester employee. The tester gets `browser_open` (signed in as a role: the platform types password and code, the model never sees them), `browser_act`, `browser_look` and `report_app_test`. The browser runs in the platform as the unprivileged `wfos-browser` user in a systemd scope with a memory limit; its resolver knows only the preview's domain (mapped to the app server, 127.0.0.1 for this host) and other origins are aborted; what pages show is untrusted (taint). Findings land in Needs a decision; each becomes a fix task with one click, and the LIVE release card shows the latest test of that commit. Setup: `deploy/setup-ubuntu.sh --browser` (after pnpm install), `WFOS_LOCAL_SERVER_HOSTS` for previews on this host.

## Integrations

- **Inbound webhooks** (Settings → Webhooks): `POST /api/hooks/<id>` with `Authorization: Bearer <secret>` (shown once; only its sha256 is stored) creates a task for an employee or a team. 256 KB body cap, per-IP and per-trigger rate limits, `Idempotency-Key` support, delivery log with redacted excerpts (kept 30 days). The payload is fenced as data in the brief and the task starts tainted, so nothing irreversible runs without a person.
- **MCP server for machine clients** (`/api/mcp`, Settings → API access): personal API tokens (at most 365 days, revoked on password change, admin reset and removal from the workspace, untrusted by default). Tools: list/get employees, teams, tasks and conversations, `create_task`, `send_message`, `wait_for_task`, read-only `list_approvals`. No tool can approve, delete or touch credentials. Setup for Claude Code and Claude Desktop: [docs/MCP-SERVER.md](docs/MCP-SERVER.md).
- **External MCP servers with OAuth** (Settings → Integrations → Connect with OAuth): discovery, dynamic client registration and PKCE; the Owner confirms the authorization server and scopes before signing in; tokens are encrypted and refreshed under a lock. **Test connection** lists the server's tools, and the employee editor can grant or block them one by one.

## Packages (export / import)

Export teams or employees as a `*.wfos.json` package (Teams page, employee page): persona, instructions, business context, look, teams and responder modes, routines, departments, skills, optional seed memories and MCP slots (URL only). Secrets, keys, URL credentials and query values are redacted, and the export dialog lists what was redacted and what is never exported (allow-lists, credentials, chats, tasks). Import shows the full text first, needs a fresh 2FA confirmation, and creates everything in one transaction without touching anything that exists: autonomy DRAFT, every tool off, empty allow-list, routines off, MCP slots disabled (public hosts only), imported memories and skills untrusted.

## Skills

**Settings → Skills** holds `SKILL.md` skills (paste or upload; name + description frontmatter; leak-screened; 64 KB). Assign them on the employee page. Assigned skills are listed one line each in the employee's system prompt (untrusted or imported skills by name only) and read on demand with `skill_read`; an untrusted skill is returned as data and taints the run. In Workspace mode the runner installs the trusted assigned skills as `~/.claude/skills/wfos-<slug>` on every run and removes ones no longer assigned. Built-in names (pdf, docx, xlsx, pptx) are reserved.

## Memory

Per-employee memory with optional **expiry** and **supersedes**; recall skips expired and superseded memories and is placed in the user message (the system prompt stays stable across runs), next to a short "recent work" brief. Every change is journaled with **Undo** (refused if the memory changed since, unless forced). A nightly tidy (02:00 `APP_TIME_ZONE`) expires memories and supersedes exact and near-duplicates, at most 20% per pass, all journaled.

## Tests, typecheck and lint

```bash
pnpm -r typecheck
pnpm test        # shared + web + worker; never calls Claude, sends mail or touches the network
pnpm test:system # as root on a host with systemd: real sandbox units + the real Claude Code CLI against a local stub API
pnpm lint
pnpm test:deploy # upgrade.sh scenarios (stubs) + backup/restore round trip (throwaway databases)
pnpm --filter @wfos/worker run eval       # scenario evals of the safety guarantees (also part of pnpm test)
EVAL_LIVE=1 pnpm --filter @wfos/worker run eval:live   # opt-in: routing classifier accuracy against the real model (cents)
```

Scenario format, scorers and the live tier: [docs/EVALS.md](docs/EVALS.md).

The web and worker suites run against a **throwaway PostgreSQL database** that the test setup creates and drops. They need a role with `CREATEDB` that owns a template database with pgvector (one-time setup, as the postgres superuser):

```sql
CREATE ROLE workforce_dev LOGIN CREATEDB PASSWORD '…';
CREATE DATABASE workforce_os_test_template OWNER workforce_dev;
\c workforce_os_test_template
CREATE EXTENSION vector;
```

Then set `TEST_DATABASE_ADMIN_URL=postgres://workforce_dev:…@127.0.0.1:5432/postgres` in `.env`. The suites never skip: without it they fail.

**Working on a production host:** use a separate checkout (git worktree) with its own `.env`, its own database, another Redis DB index, `WFOS_ENV=development`, `WFOS_NAMESPACE=wfos-dev` and `WFOS_PROD_ENV_FILE=<path to the production .env>`. Worker, web, migrate and seed then refuse to start if they would touch the production database, Redis queues or pub/sub channels.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres / Redis |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM credential encryption |
| `AUTH_SECRET` | session JWT secret (≥ 32 chars) |
| `APP_URL` | public URL (cookie `secure` flag, links in notification emails, OAuth redirect) |
| `CLAUDE_AUTH_MODE`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | Claude Agent SDK auth |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional Google sign-in (redirect URI: `$APP_URL/api/auth/google/callback`) |
| `ALLOW_SIGNUP` | public signup (default `false`; the first user can always sign up). Admins add members in Settings → Members |
| `WORKER_CONCURRENCY`, `PER_EMPLOYEE_CONCURRENCY` | parallel runs total / per employee |
| `RUN_IDLE_TIMEOUT_MIN` | stop a run with no activity for this many minutes (default 20) |
| `STORAGE_DIR` | uploads, embedding model cache, agent sandbox dirs |
| `CLAUDE_INSTANCE_FALLBACK` | `false` = workspaces without their own Claude credential cannot run (default `true`) |
| `APP_TIME_ZONE` | time zone for dates in the UI (default `Asia/Jakarta`) |
| `WFOS_ENV`, `WFOS_NAMESPACE`, `WFOS_PROD_ENV_FILE` | dev/test isolation guard (leave unset in production) |
| `TEST_DATABASE_ADMIN_URL` | Postgres role with `CREATEDB` for the test suites |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_SUMMARY_HOUR` | optional Telegram bot (notifications, approval buttons, daily summary) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional Web Push (`pnpm --filter @wfos/worker exec web-push generate-vapid-keys`) |

## Feature map

- **Hire wizard** (`/employees/hire`), in four steps: template → persona & context → tools & autonomy → a first bounded task with a live inspector.
- **Office** (`/office`): the live 2D/3D office (see above).
- **Teams** (`/teams`): drag-and-drop membership with a crowned Lead, responder mode, export/import. A team brief gets a plan, then `delegate_subtask`, then a wait while members work, then a review (`request_revision`, once per subtask; `retry_subtask` / `reassign_subtask` after an incident), then the final deliverable. Agents talk to each other through `agent_messages`, which are logged as Activity.
- **Chat** (`/chat`) streams over SSE, accepts attachments (which are indexed into the knowledge base), shows approvals inline, supports `@mentions`, edit/regenerate with versions, deep links (`/chat?c=…&m=…`), and can turn a message into a task.
- **Task board** (`/tasks`) is a Kanban by status, filterable by employee, client and project. The task page is the **Activity Inspector**: every LLM call, tool call, guard hit, approval and compaction, with model, tokens, latency and credits.
- **Routines** (`/routines`): 5-field cron + timezone with a live readable preview and the next three runs, one task per client, overlap policy (skip / queue), missed runs (more than 12 h late) recorded instead of run, run history, run now.
- **Approvals** (`/approvals`, and inline in chat) previews the exact payload (email as it will be sent, invoice PDF, webhook text, routine schedule, skill text) and offers Approve, Edit & Approve, or Reject with feedback. The feedback is written to the employee's memory. Cards from an older version of a conversation are marked.
- **Dry run** swaps irreversible tools for mocks that record what *would* have happened. **Replay** re-runs past tasks with proposed instructions and shows old vs new outputs side by side with a diff before you promote the change.
- **Employee page**: plain-language **Activity** tab ("Sent an email to …"), memory panel with states, expiry and history, skills, per-tool MCP permissions.
- **Memory & knowledge**: per-employee memory you can edit (see Memory above), and a workspace knowledge base (PDF/DOCX/MD → chunks → local 384-d embeddings with all-MiniLM-L6-v2 and pgvector HNSW). `kb_search` answers come with citations.
- **Demo Mode** runs a scripted lifecycle (PM plans → Developer builds → QA reviews → Finance drafts invoice → approval → email "sent" as a dry run → Lead review) that emits the same SSE events.
