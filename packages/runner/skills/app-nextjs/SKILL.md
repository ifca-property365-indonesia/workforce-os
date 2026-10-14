---
name: app-nextjs
description: Build a web app that Workforce OS can publish as a preview (Next.js + PostgreSQL, wfos-app.json, health check, migrations). Use when a task asks for a new app, or changes an app that has a preview (list_apps).
---

# Apps for Workforce OS previews (Next.js)

The platform builds and runs your app on an app server, at `https://<slug>.<preview domain>` (see `list_apps`).
It only runs apps that follow these rules. A preview is deployed only after a person approves it, and it is live only
when the platform reports the release as deployed.

## Start a new app

Copy the starter into the root of your repository (it is a Next.js app with one page and one table):

```sh
cp -r ~/.claude/skills/app-nextjs/template/. .
```

Then change it into what the task asks for. Keep the structure below.

## wfos-app.json (repository root, required)

```json
{
  "type": "nextjs",
  "install": "pnpm install --frozen-lockfile",
  "build": "pnpm build",
  "start": "pnpm start -H 127.0.0.1 -p $PORT",
  "migrate": "pnpm migrate",
  "health": "/api/health",
  "database": true,
  "memoryMb": 512
}
```

- `type`: always `nextjs`.
- `install`, `build`: run on the server in a sandbox, in that order (install up to 15 min, build up to 20 min, 1.5 GB).
- `start`: must listen on `127.0.0.1` and `$PORT` (set by the platform). Keep `next start -H 127.0.0.1 -p $PORT`.
- `migrate` (optional): runs after the build and before the new version starts; the platform backs the database up
  first. Leave it out when the app has no database changes.
- `migrations` (optional, `"breaking"` by default): how LIVE runs the migration. `"breaking"`: LIVE shows a
  maintenance page, stops the old version, migrates, and a failed release restores the database from the backup.
  `"expand"`: the migration runs while the old version keeps serving (no downtime) and is never undone, so it may only
  add (new tables, nullable columns or columns with a default, plain indexes). A release that claims `"expand"` is
  refused when its changed migration files drop, rename, change a type, add NOT NULL / constraints / unique indexes,
  update or delete rows, replace functions/views/triggers, or are not plain `.sql` (a changed `scripts/migrate.mjs`
  or a JS migration cannot be checked). This check is a best-effort lint of the files, not a proof: keep expand
  migrations as plain SQL files that only add, and mark anything else `"breaking"`.
- `health`: a GET path that answers 2xx when the app is ready. The deploy fails (and rolls back) when it does not.
- `database`: `true` = the platform creates a PostgreSQL database for the app and sets `DATABASE_URL`.
- `memoryMb`: memory of the running app, 256 to 1024.
- No other fields (the file is validated; an unknown field fails the preview request).

## package.json and the lockfile

- Keep `"packageManager": "pnpm@10.33.0"` and use pnpm only (no npm/yarn lockfiles).
- Always commit `pnpm-lock.yaml`: the server runs `pnpm install --frozen-lockfile`, so a lockfile that does not match
  package.json fails the install step.
- Adding a dependency: `pnpm add <name>` (or `pnpm install` after editing package.json). It needs the network, so it
  goes to a person for approval as a command; wait for it, then commit package.json and pnpm-lock.yaml together.
- Scripts the manifest uses: `build` = `next build`, `start` = `next start`, `migrate` = `node scripts/migrate.mjs`.
  A change to `scripts` is shown to the approver as a warning.

## Health check

`/api/health` must check the database (`SELECT 1`) and answer 503 when it is not reachable, 200 otherwise
(see `app/api/health/route.ts`). Mark it `export const dynamic = "force-dynamic"`.

## Database

- `DATABASE_URL` looks like `postgresql://app_x:...@localhost:5433/app_x?host=/run/wfos-apps-pg`: the database is
  reachable only through its unix socket, named by `?host=`. Connect with `lib/db.mjs` (it passes the socket folder
  to the driver); a plain TCP connection to localhost does not work.
- There is no database during `pnpm build`. Every page or route that touches the database must be dynamic
  (`export const dynamic = "force-dynamic"`), and nothing may query it at import time.
- Migrations live in `pnpm migrate` (`scripts/migrate.mjs`, which can run the `.sql` files of `migrations/`) and must
  be idempotent: they run on every deploy, also when a release reuses a build already on the server
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, …). Avoid destructive statements (DROP TABLE,
  DROP COLUMN, TRUNCATE, DELETE FROM): the approver sees them as a warning and data cannot come back after a
  successful deploy.

## Files, network, environment

- The app can only write to `$APP_DATA_DIR` (kept across releases, e.g. uploads) and `.next/cache`. Everything else
  (the release folder, /tmp of other apps, the home directory) is read-only or not there.
- The app cannot reach private networks or services on the server (localhost, 10.x, 192.168.x, cloud metadata …):
  only its own database socket and the public internet. Do not build features that call internal hosts.
- Variables the platform sets (do not set them yourself, do not commit `.env` files): `PORT`, `HOST` (127.0.0.1),
  `NODE_ENV` (production), `APP_URL` (the preview URL), `APP_SECRET` (random, stable: sign cookies/tokens with it),
  `APP_VERSION` (the commit), `APP_DATA_DIR`, and `DATABASE_URL` when `database` is true.
- Other settings (API keys, SMTP …): read them from `process.env.NAME` with a safe default, list them in README.md,
  and tell the person in your summary which names an Admin must add (Apps → the app → Environment variables). Never put a
  secret in the repository.

## Publishing

1. Run the build and the tests locally where you can, commit (including pnpm-lock.yaml).
2. `git_push` and wait for the approval (your run ends; the task comes back to you once the push ran).
3. `list_apps` → the app with `linkedToYourRepository: true` → `request_preview { appId, summary }`.
4. End your run. The platform resumes the task with the result: a "Preview: <url>" deliverable when it is deployed,
   or the failed step with the end of the build log (fix, commit, push, request the preview again).
