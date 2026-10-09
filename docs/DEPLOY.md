# Deploying Workforce OS

Fresh Ubuntu 24.04 or 26.04 VPS → running HTTPS instance. The native install (PM2) is the primary path. It is the only one
where **Workspace mode** (Claude Code in a per-task sandbox) is available. Docker Compose is the alternative at the
end.

**You need:** a VPS running Ubuntu 24.04 with root access; 2 GB RAM minimum (4 GB recommended if employees use
Workspace mode, or to build without swap); a domain with an A record pointing to the server; an email address for
Let's Encrypt.

## 1. Install

```bash
git clone <repo-url> /opt/workforce-os && cd /opt/workforce-os
cp .env.example .env
```

Fill in `.env`. Generate the values in place and keep a copy somewhere safe:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://workforce:<password>@127.0.0.1:5432/workforce_os` (the setup script creates this role and database) |
| `REDIS_URL` | `redis://:<password>@127.0.0.1:6379/0` (the setup script sets this Redis password) |
| `ENCRYPTION_KEY` | `openssl rand -hex 32`. **Losing it makes every stored credential unreadable.** |
| `AUTH_SECRET` | `openssl rand -base64 48` |
| `APP_URL` | `https://ai.example.com` |
| `CLAUDE_INSTANCE_FALLBACK` | `false` if other people can sign up (each workspace brings its own Claude credential) |

Then run, as root:

```bash
deploy/setup-ubuntu.sh --domain ai.example.com --email you@example.com
```

It installs Node 24, pnpm, PM2, PostgreSQL + pgvector (the release's own major: 16 on 24.04, 18 on 26.04), Redis 7 (`noeviction`, local only, password from
`REDIS_URL`), creates the database from `DATABASE_URL`, enables the firewall (SSH, 80, 443; skip with `--no-firewall`),
configures Nginx with a Let's Encrypt certificate, checks the sandbox prerequisites (systemd ≥ 252, cgroup v2) and
installs the document toolchain. It is idempotent: run it again after changing `.env`.

```bash
pnpm install --frozen-lockfile
pnpm db:migrate && pnpm db:seed       # seed = model prices only (SEED_DEMO=true adds demo data)
pnpm build                            # ≈1.2 GB RAM peak; on 2 GB hosts add swap first (below)
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup systemd
pm2 install pm2-logrotate
curl -s http://127.0.0.1:3010/api/health   # "status":"ok" once the worker's first heartbeat arrives
```

Swap for building on a 2 GB host:
`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`.

Open `https://ai.example.com` and **sign up**. The first account becomes the Owner of its workspace. After that,
`ALLOW_SIGNUP=false` (the default) means Admins add people in **Settings → Members**.

## 2. Claude credential per workspace

Each workspace uses its own Claude credential: **Settings → Claude credential** (Owner only).
- **Subscription** (Pro/Max): run `claude setup-token` on any machine with Claude Code, then paste the token
  (`sk-ant-oat01-…`). The dashboard then shows the 5-hour and weekly limits.
- **API key** (`sk-ant-api…`): billed per token; the dashboard shows credits/USD.

The credential is encrypted with `ENCRYPTION_KEY`. Only its type and last 4 characters are ever shown, and a run gets
only its own workspace's credential, and only while it runs; in Workspace mode, it never enters the sandbox at all.
An instance-wide fallback (`CLAUDE_AUTH_MODE` + `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in `.env`) is used
only while `CLAUDE_INSTANCE_FALLBACK=true`. Check a credential end to end:
`pnpm --filter @wfos/worker exec tsx src/scripts/sdk-smoke.ts <employeeId> "Reply with exactly: pong"`.

Optional, per workspace in Settings: SMTP (outgoing email), webhook, repositories (Git tokens for code delivery),
departments, MCP servers. Instance-wide in `.env`:
- Google sign-in: `GOOGLE_CLIENT_ID`/`SECRET`.
- Telegram: `TELEGRAM_*`. After setting it, register the webhook once, with the `curl … setWebhook` command in
  `.env.example`.
- Web Push: `VAPID_*`. Generate the keys with `pnpm --filter @wfos/worker exec web-push generate-vapid-keys`.

Restart after changing `.env`: `pm2 reload ecosystem.config.cjs --update-env`.

## 3. Health and logs

`GET /api/health` returns `status`:
- `ok`;
- `degraded`: the web serves but no fresh worker heartbeat, or Workspace-mode employees exist and the sandbox is not
  ready;
- `down` (503): no database or Redis.

`?strict=1` also answers 503 when the status is `degraded`, for monitors. The response carries no error text; see
`pm2 logs wfos-worker` / `pm2 logs wfos-web`.

## 4. Backups and restore

```cron
30 2 * * * /opt/workforce-os/deploy/backup.sh >> /var/log/workforce-os-backup.log 2>&1
```

Each run writes to `/root/backups/workforce-os` (14 days; `BACKUP_DIR`, `KEEP_DAYS`): a verified `pg_dump`, the
uploads, the git mirrors, `.env`, and a checksum manifest. **Copy them off the server** (rclone, S3, another VPS).
Task workspaces are temporary by design and are not backed up; deliverables live in the database.

Restore onto a new or rebuilt server:
1. Install with step 1, without starting PM2.
2. Create an empty database with the extension:
   `sudo -u postgres psql -c "CREATE DATABASE workforce_os OWNER workforce" -c "\c workforce_os" -c "CREATE EXTENSION vector"`.
3. Run:
   ```bash
   deploy/restore.sh --backup /root/backups/workforce-os/wfos-<stamp> --target-url "$DATABASE_URL" \
     --storage /opt/workforce-os/storage --env-out /opt/workforce-os/.env.restored
   ```
4. Use the restored `ENCRYPTION_KEY` (from `.env.restored`) in `.env`.
5. Run `pnpm db:migrate`, then `pm2 start ecosystem.config.cjs`.

`restore.sh` checks the checksums and refuses a non-empty database or existing files. `pnpm test:deploy` proves the
whole round trip on throwaway databases.

## 5. Upgrades

```bash
deploy/upgrade.sh            # or: deploy/upgrade.sh --ref origin/main
```

It records the current commit, fetches, checks free RAM (`MIN_FREE_MB`, default 1500; `--stop-web-for-build` stops the
site during the build instead), waits until no agent run is active, takes a backup, fast-forwards, then runs
`pnpm install --frozen-lockfile`, the migrations, the build and `pm2 reload`. It then waits until `/api/health?strict=1`
reports `ok` **with the new commit** from the worker. On any failure it resets to the recorded commit, reinstalls,
rebuilds, reloads and checks health again. Migrations are additive and stay applied; the backup is the way back for
data. With `WFOS_WEB_INSTANCES=2` (enough RAM) the web reloads with no downtime; with one instance it restarts in a
few seconds. The log is `storage/upgrade.log`.

## 6. Rotating keys and secrets

| Secret | How |
|---|---|
| `ENCRYPTION_KEY` | Put the old key in `ENCRYPTION_KEY_PREVIOUS` and a new one (`openssl rand -hex 32`) in `ENCRYPTION_KEY`, then reload. Run `pnpm --filter @wfos/db cli rotate-key` (re-encrypts every credential, repository token, webhook URL and 2FA secret in one transaction), reload again, then remove `ENCRYPTION_KEY_PREVIOUS`. Take a backup first. |
| `AUTH_SECRET` | Replace and reload. Everyone is signed out, and pending Telegram approval buttons stop working (approve on the web). |
| Claude credential | **Settings → Claude credential**: paste the new one under "Replace with" (per workspace). For the instance fallback, edit `.env` and reload. |
| Repository / SMTP / MCP tokens | Replace them in the workspace Settings, then revoke the old token at the provider. |
| Database password | `sudo -u postgres psql -c "ALTER ROLE workforce PASSWORD '<new>'"`, update `DATABASE_URL`, reload. |
| Redis password | Update `REDIS_URL`, run `deploy/setup-ubuntu.sh --no-firewall` (it sets `requirepass`), reload. |
| `TELEGRAM_WEBHOOK_SECRET` | Update `.env`, reload, run the `setWebhook` command again. |
| VAPID keys | Generate new keys and reload; users turn push on again (old subscriptions stop working). |

## 7. Docker Compose (alternative)

```bash
curl -fsSL https://get.docker.com | sh
git clone <repo-url> workforce-os && cd workforce-os
cp .env.example .env   # DOMAIN, POSTGRES_PASSWORD, ENCRYPTION_KEY, AUTH_SECRET, APP_URL=https://$DOMAIN
./deploy/init-letsencrypt.sh you@example.com
WFOS_COMMIT=$(git rev-parse --short=12 HEAD) docker compose up -d --build
```

Compose runs Postgres (pgvector), Redis, a one-shot migrate (migrations + price seed), web, worker, Nginx and certbot.
Workspace mode is **not available** under Docker: the container has no systemd to start sandbox units, so it fails closed
(health shows the sandbox as unavailable, which only degrades the status when an employee uses Workspace mode). Tool
mode works fully. Upgrade with `git pull && docker compose up -d --build`; back up with `docker compose exec postgres
pg_dump …` plus the `storage` volume.
