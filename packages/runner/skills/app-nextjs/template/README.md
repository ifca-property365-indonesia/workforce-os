# Workforce OS app

A Next.js + PostgreSQL starter that Workforce OS can preview.

- `wfos-app.json` tells the platform how to install, build, migrate, start and health-check the app.
- The platform creates the database and sets `DATABASE_URL` (unix socket, no TCP).
- `GET /api/health` answers 200 when the app and its database are ready.
- `pnpm migrate` creates the tables (idempotent); the platform backs the database up before it runs.
