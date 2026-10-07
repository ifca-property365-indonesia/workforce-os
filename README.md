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
| Credentials | AES-256-GCM (`ENCRYPTION_KEY`). They are never returned to the browser or given to the model |

Run `pnpm --filter @wfos/worker exec tsx src/scripts/safety-check.ts <workspaceId>` to check the gate against a real DB and SMTP. It needs no Claude token.

## Credits & pricing

1 credit = $0.01. Settings → Pricing publishes the credits per model per 1K tokens (input, output, cache read, cache write) and per tool call, and includes a cost forecaster. Every LLM step is charged from that table and shows up in the task's Activity Inspector.

## Claude authentication

`CLAUDE_AUTH_MODE=oauth` uses `CLAUDE_CODE_OAUTH_TOKEN`, for personal or internal use. Create a token with `claude setup-token`.
`CLAUDE_AUTH_MODE=api_key` uses `ANTHROPIC_API_KEY`, for multi-user or commercial use.

Without a credential, runs fail with a clear message. **Demo Mode** (Settings, or "Run scripted demo" on the Dashboard) needs no token and makes no network calls.

Check a credential end to end:
`pnpm --filter @wfos/worker exec tsx src/scripts/sdk-smoke.ts <employeeId> "Reply with exactly: pong"`

## Deploy natively with PM2 (this is how ai.vardiv.id runs)

Requires Ubuntu 24.04, Node 24, pnpm 10, PostgreSQL 16 with `postgresql-16-pgvector`, Redis 7 (set `maxmemory-policy noeviction`), and Nginx.

```bash
cp .env.example .env              # fill DATABASE_URL, ENCRYPTION_KEY, AUTH_SECRET, APP_URL, Claude credential
pnpm install
pnpm db:migrate && pnpm db:seed   # seed: 3 employees, 1 team, 2 clients, 1 weekly routine (+ owner, see below)
pnpm build                         # Next.js build (≈1.2 GB RAM peak)
pm2 start ecosystem.config.cjs && pm2 save
sudo cp nginx/ai.vardiv.id.conf /etc/nginx/sites-available/<domain> && sudo ln -s … && sudo nginx -t && sudo systemctl reload nginx
```

The seed owner is `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` (defaults `owner@workforce.local` / `workforce-demo`). **Set your own values or change the password right away** on any server that is reachable from the internet.

### Backups

`deploy/backup.sh` writes a verified `pg_dump`, the uploaded files and a copy of `.env` to `/root/backups/workforce-os` and keeps 14 days. Keep the `.env` copy, because stored credentials can only be decrypted with its `ENCRYPTION_KEY`. Schedule it with cron:

```
30 2 * * * /root/apps/workforce-os/deploy/backup.sh >> /var/log/workforce-os-backup.log 2>&1
```

The backups sit on the same disk. Copy them off the server too (rclone, S3, or another VPS). Restore steps are in the script header.

### Logs

`pm2 install pm2-logrotate`, then `pm2 set pm2-logrotate:max_size 10M` and `pm2 set pm2-logrotate:retain 7`.

## Accounts & sign-in security

- Admins add people in **Settings → Members**. New accounts get a one-time temporary password, and the user has to pick their own at first sign-in (`/change-password`). Until they do, every other page and API is blocked.
- **Settings → Account** changes your own password. A password change signs out every other session.
- Admins can **reset** a member's password (new temporary password, old sessions revoked) and **remove** members. Only Owners can act on Owners, and a workspace always keeps at least one Owner. A password reset is refused when the user also belongs to another workspace.
- Login is limited to 10 attempts per account and 30 per IP every 15 minutes, and signup to 5 per IP per hour. Behind Cloudflare, Nginx has to resolve the real visitor IP (`set_real_ip_from` + `real_ip_header CF-Connecting-IP`, see `nginx/ai.vardiv.id.conf`) and pass it as `X-Real-IP`. Without that, every visitor shares Cloudflare's IPs.

## Deploy with Docker Compose (fresh Ubuntu VPS)

```bash
curl -fsSL https://get.docker.com | sh
git clone <repo> workforce-os && cd workforce-os
cp .env.example .env   # set DOMAIN, POSTGRES_PASSWORD, ENCRYPTION_KEY, AUTH_SECRET, APP_URL=https://$DOMAIN, SEED_OWNER_PASSWORD, Claude credential
./deploy/init-letsencrypt.sh you@example.com   # issues the Let's Encrypt cert (DNS A record must point here)
docker compose up -d --build
```

Compose runs `postgres` (pgvector), `redis`, `migrate` (migrations + seed, runs once), `web`, `worker`, `nginx` (SSE-safe proxy) and `certbot` (renews every 12 hours). Uploaded files and the local embedding model live in the `storage` volume.

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

## Feature map

- **Hire wizard** (`/employees/hire`), in four steps: template → persona & context → tools & autonomy → a first bounded task with a live inspector.
- **Teams** (`/teams`): drag-and-drop membership with a crowned Lead. A team brief gets a plan, then `delegate_subtask`, then a wait while members work, then a review (`request_revision`, once per subtask), then the final deliverable. Agents talk to each other through `agent_messages`, which are logged as Activity.
- **Chat** (`/chat`) streams over SSE, accepts attachments (which are indexed into the knowledge base), and can turn a message into a task.
- **Task board** (`/tasks`) is a Kanban by status, filterable by employee, client and project. The task page is the **Activity Inspector**: every LLM call, tool call, guard hit, approval and compaction, with model, tokens, latency and credits.
- **Routines** (`/routines`): cron + timezone, one task per client, next runs, run history, run now.
- **Approvals** (`/approvals`) previews the exact payload (email as it will be sent, invoice PDF, webhook text) and offers Approve, Edit & Approve, or Reject with feedback. The feedback is written to the employee's memory.
- **Dry run** swaps irreversible tools for mocks that record what *would* have happened. **Replay** re-runs past tasks with proposed instructions and shows old vs new outputs side by side with a diff before you promote the change.
- **Memory & knowledge**: per-employee memory you can edit, and a workspace knowledge base (PDF/DOCX/MD → chunks → local 384-d embeddings with all-MiniLM-L6-v2 and pgvector HNSW). `kb_search` answers come with citations.
- **Demo Mode** runs a scripted lifecycle (PM plans → Developer builds → QA reviews → Finance drafts invoice → approval → email "sent" as a dry run → Lead review) that emits the same SSE events.
