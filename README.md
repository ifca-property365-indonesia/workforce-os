# Workforce OS

A self-hosted platform for "hiring" AI employees. Each employee is a named agent with a role, persona, business context, persistent memory, scoped tool access and an explicit autonomy level. Employees take work from chat, the task board or scheduled routines, and they can work together in teams. Any irreversible action stops at a human approval. Every step is metered, can be inspected, and can be rehearsed in a dry run.

Agents run on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). The SDK's built-in tools (Bash, file I/O, web) are **disabled**. Employees can only use the platform's own MCP tools, plus external MCP servers that an Owner connects.

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
| Tool classification (reversible / irreversible) | `packages/shared/src/index.ts` → `BUILTIN_TOOLS`, `classifyTool()` (unknown external tools fail closed = irreversible) |
| Gate (DRAFT / QUEUE / EXECUTE / CLOSE, per-tool override, Owner allow-list) | `decideGate()`, called by **every tool handler** in `apps/worker/src/tools/registry.ts`; external MCP tools go through `canUseTool` in `runner/executor.ts` |
| Per-action approval | each irreversible call creates its own `approvals` row with the exact payload; nothing runs until a human approves it, and the approved (or edited) payload is what gets executed |
| Guards (on by default) | input: prompt-injection screening of tool results, which **taints** the run so even allow-listed actions need approval. Output: secret/PII leakage check on payloads and answers (`guards/content.ts`) |
| Budgets | per-employee daily and per-workspace monthly caps are checked before each run and after every LLM step, with an SDK `maxBudgetUsd` backstop. Hitting a cap sets the employee to `PAUSED_BUDGET` |
| Kill switch | sets a DB flag, Redis pub/sub aborts every in-flight run immediately, queued work is held, and approvals cannot execute |
| Audit | `audit_log` is append-only (a Postgres trigger blocks UPDATE/DELETE/TRUNCATE) |
| Approval execution | an approved action is claimed (`APPROVED → EXECUTING`) before it runs, so concurrent or retried jobs execute it at most once |
| Web fetch | `safeFetch` (`packages/shared/src/netguard.ts`) resolves DNS itself, refuses non-public addresses (private, loopback, link-local/metadata, CGNAT, ULA, IPv4-mapped), pins the socket to the checked IP and re-checks every redirect |
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
- **Resources**: `WORKSPACE_CONCURRENCY` (default 1), `WORKSPACE_MEMORY_MAX_MB` (700), `WORKSPACE_RUNTIME_MAX_SEC`, `WORKSPACE_RETENTION_DAYS` (14; deliverables are kept). One Claude Code process needs about 300 MB at start (measured).
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

Teams and departments get their own rooms, generated from the actual employee list. The 2D view is the default; the low-poly 3D view (three.js) loads only when chosen. Clicking a character opens its task. The page lists "who is doing what" as text, respects `prefers-reduced-motion`, and stops rendering while the tab is hidden.

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
  - Admins and Owners also get **Approve / Reject** buttons. Each button is HMAC-signed, works once, only for the user it was sent to, and only while that user still has the Admin role. The decision goes through the same checks and audit log as the web (`via: telegram`).
  - Register the webhook yourself after deploy; the command is in `.env.example`.
- **Web push** (optional, `VAPID_*`):
  - The app is installable (manifest, icons, offline page).
  - **Account → Push notifications** turns push on per device.
  - The service worker never caches pages or API data.
  - Push endpoints are limited to the browsers' push services.

## Languages

The UI is available in **Bahasa Indonesia** and **English**. Each user picks a language (account menu or Account page), the workspace has a default (Settings → General), and otherwise the browser language is used. Dates, numbers and money follow the language (`Rp 1.234.567` in Indonesian) in `APP_TIME_ZONE` (default `Asia/Jakarta`). Each employee has an **output language** (workspace default / Bahasa Indonesia / English) for answers, documents and emails. Notifications, default invoice emails and invoice PDFs use the workspace language. Conventions for contributors: `docs/upgrade/I18N.md`.

## Tests, typecheck and lint

```bash
pnpm -r typecheck
pnpm test        # shared + web + worker; never calls Claude, sends mail or touches the network
pnpm test:system # as root on a host with systemd: real sandbox units + the real Claude Code CLI against a local stub API
pnpm lint
pnpm test:deploy # upgrade.sh scenarios (stubs) + backup/restore round trip (throwaway databases)
```

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
- **Teams** (`/teams`): drag-and-drop membership with a crowned Lead. A team brief gets a plan, then `delegate_subtask`, then a wait while members work, then a review (`request_revision`, once per subtask), then the final deliverable. Agents talk to each other through `agent_messages`, which are logged as Activity.
- **Chat** (`/chat`) streams over SSE, accepts attachments (which are indexed into the knowledge base), and can turn a message into a task.
- **Task board** (`/tasks`) is a Kanban by status, filterable by employee, client and project. The task page is the **Activity Inspector**: every LLM call, tool call, guard hit, approval and compaction, with model, tokens, latency and credits.
- **Routines** (`/routines`): cron + timezone, one task per client, next runs, run history, run now.
- **Approvals** (`/approvals`) previews the exact payload (email as it will be sent, invoice PDF, webhook text) and offers Approve, Edit & Approve, or Reject with feedback. The feedback is written to the employee's memory.
- **Dry run** swaps irreversible tools for mocks that record what *would* have happened. **Replay** re-runs past tasks with proposed instructions and shows old vs new outputs side by side with a diff before you promote the change.
- **Memory & knowledge**: per-employee memory you can edit, and a workspace knowledge base (PDF/DOCX/MD → chunks → local 384-d embeddings with all-MiniLM-L6-v2 and pgvector HNSW). `kb_search` answers come with citations.
- **Demo Mode** runs a scripted lifecycle (PM plans → Developer builds → QA reviews → Finance drafts invoice → approval → email "sent" as a dry run → Lead review) that emits the same SSE events.
