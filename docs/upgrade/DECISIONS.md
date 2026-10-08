# Upgrade v2 — decisions log

Each entry: the decision, why, and the alternative that was rejected.

## D1. Work in a separate worktree, never in the production checkout
Production (`wfos-worker`) runs `tsx src/index.ts` straight from `/root/apps/workforce-os`, so any checkout or
`pnpm install` there would change what production loads on its next restart. All work happens in the worktree
`/root/apps/workforce-os-v2` (branch `upgrade/v2`) with its own `node_modules` and `.env`.
Rejected: switching branches in the main checkout.

## D2. Dev/test isolation: own database, own Redis index, own namespace, enforced at startup
Dev uses database `workforce_os_dev` (role `workforce_dev`, `CREATEDB` so tests can create throwaway databases),
Redis DB 13 and `WFOS_NAMESPACE=wfos-dev`. Redis pub/sub channels are global across DB indexes, so the namespace
prefixes both the BullMQ keys (`prefix`) and the event/control channels. Without it, a dev kill switch could
reach production runs and a dev worker could consume production jobs.
`assertNotProductionTarget()` (`packages/shared/src/runtime.ts`) runs in the worker, web, migrate and seed
entry points. It is active only when `WFOS_ENV=development|test`, so production boots unchanged. It refuses to start
when `DATABASE_URL`/`REDIS_URL`/namespace match the production env file.
Rejected: relying on a different Redis DB index alone (pub/sub leaks across indexes); enabling the guard by
default (it would need to know which instance is "production", and a mistake there would stop production).

## D3. Taint/leak override is one pure function
`applyRunSignals()` in `@wfos/shared` is used by both the platform tool path (`registry.ts`) and the external
MCP path (`executor.ts`), so "taint forces approval" cannot drift between them and is unit-tested once.

## D4. Approved actions run at most once (new status EXECUTING)
`executeApproval` used to read `APPROVED`, run the action and only then mark it `EXECUTED`. Two concurrent jobs, or
a retry after a crash, could therefore send the same email twice. A test showed 5 parallel calls sending more than
once. The executor now claims the row first (`APPROVED → EXECUTING`, conditional UPDATE … RETURNING). If the
process dies mid-action, the approval stays `EXECUTING` and is not retried automatically, because for
irreversible actions "maybe not sent" needs a human, never a blind retry.
Rejected: relying on the BullMQ jobId for dedupe (does not cover retries after a crash).

## D5. Worker tests use a real throwaway Postgres and mocked transports
`apps/worker/test/global-setup.ts` clones `workforce_os_test_<pid>_<ts>` from the template
`workforce_os_test_template` (pgvector is not a trusted extension, so a non-superuser role cannot create it in
a fresh database), migrates it, and drops it at the end. Redis, SMTP and embeddings are replaced with in-memory mocks,
`fetch` is stubbed to fail, and any attempted network call fails the test. The Agent SDK is swapped through
`runner/sdk.ts` for the scripted `runner/mock-sdk.ts`. The suites never skip: no `TEST_DATABASE_ADMIN_URL`, no run.
Rejected: testcontainers (no Docker on the host); mocking the database (the audit trigger and the approval claim
are database behaviour and must be tested against Postgres).

## D6. SSRF: pin the socket with a custom `lookup`, not a new HTTP client
`safeFetch` (`packages/shared/src/netguard.ts`) resolves DNS itself, requires every A/AAAA record to be public, and
then passes a `lookup` function to `http(s).request` that returns only the validated address, so the socket cannot
resolve again (no DNS-rebinding window). TLS still verifies against the hostname. Redirects are followed manually
(max 5) and each hop goes through the same check. IPv4 forms (decimal/octal/hex/short) are normalised by the WHATWG
URL parser before the check, and IPv4-mapped/compatible/NAT64 IPv6 addresses are judged by their embedded IPv4.
If any record of a multi-record answer is private, the whole request is refused.
Rejected: undici `Agent` with `connect.lookup` (an extra dependency for the same effect); a hostname regex (what we
had: misses DNS, redirects and alternate IP notations).

## D7. 2FA: TOTP implemented with node:crypto; mandatory-for-admins defaults to ON
TOTP (RFC 6238, SHA-1, 30 s, 6 digits, ±1 step, replay-protected via the last accepted step) and base32 live in
`packages/shared/src/totp.ts` and are tested against the RFC vectors, so no dependency is needed. The secret is stored
AES-256-GCM encrypted. The 10 recovery codes (50 bits each) are stored as SHA-256 hashes and consumed with a
conditional update. `workspaces.require_2fa_admins` defaults to `true`: after this migration an existing Owner or
Admin is sent to `/setup-2fa` at the next sign-in, and every other API answers 403
`two_factor_enrollment_required` until they enroll. Only an Owner can switch the requirement off.
Rejected: `otplib`/`speakeasy` (small, well-specified algorithm; fewer dependencies in the auth path); default OFF
(the brief says mandatory for Owner/Admin).

## D8. Lockout: 5 failures → 15 minutes, counted in the database
Wrong passwords and wrong second-factor codes both count. The 5th failure sets `locked_until` in one atomic UPDATE.
While locked, even the right password is refused with 423 and `lockedUntil`, and the UI formats it as "try again at
<local time>". The existing Redis rate limits (per account/IP) stay as a first layer. Known trade-off: someone who
knows an email address can keep that account locked (a denial of service). The owner CLI (`pnpm --filter @wfos/db cli
unlock <email>`) clears it.
Rejected: lockout in Redis only (lost on restart, and the CLI could not inspect it).

## D9. Google sign-in goes through the same lockout and 2FA step
The Google callback now only proves the first factor. Lockout and the TOTP step apply exactly as for password sign-in.

## D10. Step-up re-auth cookie for sensitive changes
`POST /api/me/reauth` (password + TOTP) sets a 10-minute signed `wfos_stepup` cookie that `requireStepUp()` checks.
Phase 1.1 uses it for switching an employee to Workspace mode.

## D11. Claude credentials: one per workspace, resolved per run, instance env as an optional fallback
`credentials` rows with `kind='claude'` hold `{type, last4}` in `config` and the AES-256-GCM-encrypted secret.
`resolveClaudeCredential(workspaceId)` (`packages/db/src/claude.ts`) is called by `runAgent` for every run and returns
the workspace's credential, else the instance env credential while `CLAUDE_INSTANCE_FALLBACK` is not `false`, else
nothing (the run fails with a clear message and the SDK is never started). The agent env is an explicit allow-list
(PATH, HOME, LANG, three SDK flags, one credential). A test asserts the exact key set and that no platform secret or
other tenant's token appears. The agent HOME is now per workspace (`storage/agent-home/<workspaceId>`), because
Claude Code writes session transcripts there.
The fallback defaults to `true` so the current production instance keeps working after the upgrade without any
action. Owners should set it to `false` once every workspace has its own credential.
Only Owners can set/remove a credential (billing + access), Admins can see the status. Setting it is audited with
type and last 4 characters only.
Rejected: requiring a step-up re-auth to change the credential (not asked for; Owner role + audit suffice for now).

## D12. i18n: next-intl without locale routing; per-namespace catalogs; a test instead of a lint plugin
URLs stay the same (`/settings`, not `/id/settings`). The locale is resolved per request in `src/i18n/locale.ts`: the
user preference (`users.locale`), then the workspace default (`workspaces.default_locale`), then the `wfos_locale`
cookie (language switch on signed-out pages) or `Accept-Language`, then English. Catalogs are split by namespace
(`messages/<locale>/<ns>.json`) so several people (or agents) can work on different screens without conflicts.
The "untranslated strings" rule is `apps/web/test/i18n.test.ts`, a TypeScript-AST scan run by `pnpm test`. It
understands namespaced translators, so it can also prove that every literal key exists, that id/en have the same
keys and ICU placeholders, and that every `HttpError` carries a translated `code`. Server errors are translated on the
server (the client shows `error`), so toasts are localised without a client-side error map.
Rejected: locale-prefixed routes (breaks existing links and the PM2/Nginx setup for no gain in a logged-in app);
`eslint-plugin-i18next` (can't verify key existence or id/en parity); one big catalog file (merge conflicts).

## D13. Employee output language: inherit → workspace default; unset workspace → mirror the request
`employees.output_language` is `inherit | id | en`. With `inherit` and no workspace default, no language
instruction is added and the employee answers in the language of the request (the previous behaviour). Worker-side
text that people read (notifications, default invoice email, invoice PDF) uses the workspace default language
(`packages/shared/src/messages.ts`). An approved payload, including a human-edited subject/body, is always sent
exactly as approved.

## D14. Workspace-mode isolation: per-run transient systemd unit + credential-injecting egress gateway (proposed, awaiting owner OK)
See `SPIKE-sandbox.md`. Each Workspace-mode run becomes its own `systemd-run` unit (`DynamicUser`, `PrivateNetwork`,
`ProtectSystem=strict`, `ProtectHome`, `ProtectProc=invisible`, cgroup limits), started by the root worker. The only
way out is a Unix-socket gateway that allow-lists hosts and injects the workspace's Claude credential, so the sandbox
never holds a real token. The SDK's bubblewrap sandbox stays off, and a test asserts it can never be switched to
fail-open.
Rejected: (a) a `wfos-runner` UID alone. The probe showed it can talk to the password-less production Redis
(`+PONG`), and bwrap would need host-wide AppArmor/sysctl changes on Ubuntu 24.04. (c) podman/gVisor: too heavy for a
2 GB host and rootless podman hits the same userns restriction. (d) a separate VM: strongest, but needs a second host;
it stays the recommended upgrade path when the budget allows.

## D14 status: approved by the owner (2026-10-08), "with conditions proven by tests in Phase 1"
The conditions are the claims of the spike report. Each is now a test on real units (`pnpm test:system`, see PHASE-1).

## D15. Bash classifier: parse with mvdan/sh; workspace scripts run, inline interpreter code does not
`packages/shared/src/bash-classifier.ts` uses mvdan/sh (the shfmt parser, GopherJS build `mvdan-sh`) and walks every
command, including those inside `$()`, backticks, process substitution, subshells, functions, heredocs, `bash -c` /
`sh -c` / `eval` strings (recursively), `env`/`nice`/`timeout`/`xargs`/`find -exec` wrappers and redirections.
**Write-then-run:** running a script that lives in the workspace (`./x.sh`, `node build.js`, `pnpm test`) is
allowed in a clean run, because the sandbox decides what any code can do (no host access, egress allow-list).
**Inline code** (`python -c`, `node -e`, `perl -e`, scripts piped into a shell) always needs approval, because it is the
usual way to hide intent and cannot be reviewed as a file. Once a run is tainted, only read-only commands run
without approval.
Rejected: `sh-syntax` (its AST only carries positions); regex classification (the brief forbids it, and it fails on
quoting tricks — 124 red-team commands prove the parser-based approach).

## D16. The runner holds no credential, not even its own workspace's
The CLI honours `ANTHROPIC_BASE_URL`; the gateway on the run's `api.sock` accepts only the run's random token and
substitutes the workspace credential. The E2E test shows the real token upstream, never inside the sandbox.
Claude Code does not pass its token to Bash commands at all, so commands cannot even see the dummy.

## D17. Git: the root worker never runs git in the agent's repository
Repo-local config (`core.fsmonitor`, `core.sshCommand`, filters) and hooks would run as root. Clone/refresh happen
in the sandbox (mirror mounted read-only, trusted via a read-only global gitconfig, since git 2.43 ignores
`safe.directory` from `GIT_CONFIG_*`). Commits leave as a bundle on stdout, are imported into the platform mirror,
and only the exact approved commit is pushed, from the mirror, with the platform token in `GIT_CONFIG_*` env (never on
disk or argv). A push approval cannot be edited. The approved head is re-checked at execution.
Rejected: running `git push` from the workspace with hooks disabled via `-c core.hooksPath` (fsmonitor/filters/
sshCommand would still run); giving the agent a token scoped to one repo (the brief: the agent never holds it).

## D18. Root never writes into an existing workspace
Found while adding skill seeding: `prepareWorkspaceDirs` used to `mkdir` inside the task state dir on every run. After
the first run that directory belongs to the sandbox UID, and a planted symlink (home → /etc) would have redirected
root's write. Now root populates a workspace only when it does not exist yet; tested with a planted symlink.

## D19. Platform mount points live on a unit-private tmpfs under /mnt
systemd creates missing bind-mount destinations on the host (the spike left an empty `/opt/node`, since removed).
All platform mounts are now under `TemporaryFileSystem=/mnt` (`/mnt/wfos/{node,runner,claude,run,upstream.git}`),
and ExecStart goes through `/bin/sh` because systemd resolves the executable on the host.

## D20. Workspace mode is native-only for now; the Docker path keeps Tool mode
Transient systemd units need root and a host systemd. Inside the Compose `worker` container neither exists, so
Workspace mode fails closed there with a clear message (`sandboxAvailable()`), and Tool mode works as before.
A Compose `runner` service would need its own isolation design (one container per run through the Docker API,
which means giving the worker the Docker socket = root on the host). It is deferred, and Phase 4 will document it.
Rejected for now: privileged nested systemd in a container (weakens the boundary we just proved).

## D21. Chat stays in Tool mode
Workspace mode runs for tasks only. A chat with a Workspace-mode employee uses platform tools and can create a
task, so every shell session has a task, a workspace, a session id and a deliverable view.
