# syntax=docker/dockerfile:1
# Multi-target image for the pnpm monorepo: `web` (Next.js) and `worker` (BullMQ + Claude Agent SDK).
FROM node:24-bookworm-slim AS base
# commit shown by /api/health (.git is not copied into the image)
ARG WFOS_COMMIT=""
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 WFOS_COMMIT=$WFOS_COMMIT
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build-web
COPY . .
RUN pnpm --filter @wfos/web build

FROM base AS web
ENV NODE_ENV=production
COPY --from=build-web /app /app
WORKDIR /app/apps/web
EXPOSE 3010
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3010", "-H", "0.0.0.0"]

FROM deps AS worker
ENV NODE_ENV=production
COPY . .
WORKDIR /app/apps/worker
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

FROM deps AS migrate
COPY . .
WORKDIR /app/packages/db
CMD ["sh", "-c", "node node_modules/tsx/dist/cli.mjs src/migrate.ts && node node_modules/tsx/dist/cli.mjs src/seed.ts"]
