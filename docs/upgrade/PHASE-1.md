# Phase 1 — Workspace mode (Claude Code in a sandbox)

Design (b) from the spike was approved by the owner on 2026-10-08 on the condition that its claims are proven by
tests. They are: every claim below has a test that runs against real systemd units on this host.

## What changed

| Item | Change | Where |
|---|---|---|
| 1.1 Modes | `employees.execution_mode` (`tool` default, `workspace`) and `egress_domains`. Switching to Workspace, hiring into it, or widening egress needs Owner/Admin + a fresh password/2FA step-up. Developer template defaults to Workspace mode with package-registry egress | `apps/web/src/app/api/employees`, `components/account/step-up.tsx` |
| 1.2 Runner | Each run = transient systemd unit (DynamicUser stable per task, PrivateNetwork, ProtectSystem=strict, ProtectHome, ProtectProc=invisible, no capabilities, memory/task/CPU/runtime limits). `@wfos/runner` (bundled) runs inside and talks to the worker only through 3 Unix sockets: control (per-run token), Anthropic API gateway (injects the credential; the sandbox has a dummy), egress CONNECT proxy (per-employee host allow-list). Host-wide concurrency limit (default 1) | `packages/runner`, `apps/worker/src/runner/workspace/*` |
| 1.3 Classifier | Real shell parser (mvdan/sh). Allow only read/local work; approval card with the exact command for everything else; taint → only read-only commands; approved commands run in the same sandbox with git hooks disabled; output fed back to the session | `packages/shared/src/bash-classifier.ts`, `runner/workspace/permissions.ts`, `exec.ts` |
| 1.4 Git | Repositories per workspace (token encrypted, never returned). Platform bare mirror; clone/refresh inside the sandbox on `agent/<task>`; `git_push`/`create_pull_request` platform tools (irreversible); bundle export → diff in the platform mirror → approval with the exact head → push from the mirror; conflicts and failed pushes return to the agent; Code tab with file tree, highlighted diff, last test run, Approve & push / Request changes / Discard | `runner/workspace/git.ts`, `components/inspector/code-*.tsx`, `components/settings/repositories.tsx` |
| 1.5 Toolchain | `deploy/setup-ubuntu.sh --toolchain` (idempotent, pinned Python libs); built-in skills docx/xlsx/pptx/pdf seeded into new workspaces | `deploy/setup-ubuntu.sh`, `packages/runner/skills` |
| 1.6 Continuity | Session id saved per task, follow-ups resume it in the same workspace; stop/cancel/kill switch stop the unit (whole cgroup); hourly GC after `WORKSPACE_RETENTION_DAYS` (deliverables kept) | `runner/task.ts`, `runner/workspace/gc.ts` |

Migration added: `0005_workspace_mode.sql` (additive).

## How it was verified

`pnpm -r typecheck` ✔, `pnpm lint` ✔, `pnpm test` ✔ (shared 383, web 37, worker 46), `pnpm test:system` ✔ (29, as root
with systemd, on this host). All counts from the final run.

The conditions of D14, each with the test that proves it:

| Claim | Test (`apps/worker/test/system/…` unless noted) |
|---|---|
| Sandbox cannot read the production `.env`, this checkout's `.env`, `/etc/shadow` | `sandbox-boundary` › platform secrets |
| Sandbox cannot see or read the worker process env (which holds `DATABASE_URL`) | same |
| Sandbox env has no platform secret or credential | same + `agent-e2e` (printenv seen by the real CLI) |
| No access to Postgres (TCP + socket), Redis, the web app | sandbox-boundary › host services |
| No internet; allow-listed hosts only via the proxy; other hosts 403; proxy refuses host services | sandbox-boundary › network |
| Cannot write outside the workspace; cannot read another task's workspace; no privilege gain | sandbox-boundary › filesystem |
| Memory limit enforced; stop kills the whole process tree | sandbox-boundary › resources |
| The real Claude Code CLI works inside: edit, test, commit, platform tool; the gateway sends the real credential upstream while the sandbox never sees it | `agent-e2e` |
| A risky command becomes an approval with the exact command and is not run | `agent-e2e` |
| Follow-up resumes the same session and workspace | `agent-e2e` › follow-up |
| Push only after approval, only the exact approved commit; planted hooks/fsmonitor/sshCommand never run as root | `git-delivery` |
| Moved branch after approval → nothing pushed; conflicts → rebase instruction; failed push → follow-up step | `git-delivery` |
| PR opened with the platform token (provider API mocked) | `git-delivery` |
| 124 red-team commands need approval; 53 normal developer commands do not; taint rules | `packages/shared/test/bash-classifier.test.ts` |
| Workspace mode, egress widening, hiring into Workspace need Owner/Admin + 2FA step-up | `apps/web/test/twofactor.test.ts` |
| Root never writes into an existing workspace (planted symlink); unit flags present; extra mounts confined | `apps/worker/test/workspace-dirs.test.ts` |
| Workspace GC removes only expired/discarded workspaces and keeps deliverables | same |

No test calls the real Claude service, GitHub or the internet: the CLI talks to a local stub of the Messages API,
the "remote" is a local bare repository, the provider API is mocked.

## Known limits

- **Not run against the real Claude service.** The owner's manual smoke (Definition of Done) is still to do:
  connect a repository, give a Developer employee a Claude credential, assign a small coding task, approve the push.
- **Toolchain not installed on this host.** `deploy/setup-ubuntu.sh --toolchain` has not been executed anywhere yet
  (needs owner approval here; it installs LibreOffice and friends). LibreOffice RAM is therefore **not measured** yet.
  On this host, run documents conversions with `WORKSPACE_CONCURRENCY=1`.
- **Docker path:** Workspace mode is unavailable (fails closed); Tool mode unchanged (D20).
- **Memory:** this 2 GB host can run one Workspace run at a time (300 MB at start, measured; more while building).
- **Egress is host-based:** an allow-listed host is reachable on 443 for anything it serves; per-path rules are not
  enforced. Package installs still need approval per command.
- **Skills** are seeded into new workspaces only; updated skills reach existing workspaces after they are
  garbage-collected.
- **Git providers:** pull requests for GitHub and GitLab; any https git server for clone/push.
- `next build` not run on this host (RAM); typecheck and dev-server smoke from Phase 0 cover the web app.

## For the owner before using Workspace mode in production (not done by the agent)

1. Review and merge `upgrade/v2`, run `pnpm install --frozen-lockfile`, `pnpm db:migrate` (0003–0005),
   `pnpm build` (now also builds the runner bundle), `pm2 reload wfos-web wfos-worker`.
2. Optional: `./deploy/setup-ubuntu.sh --toolchain` for document skills.
3. Strongly recommended first (SPIKE §7): Redis password; Postgres not on 0.0.0.0 / firewall.
