# Spike 1.0 — Isolation for Workspace mode on this host

Date: 2026-10-08. Host: the production VPS (then ai.vardiv.id, now workforce-os.property365.co.id). Nothing was installed and no system configuration
(packages, sysctl, AppArmor, firewall, systemd unit files, users, Nginx) was changed. The experiments used
**transient** systemd units with `DynamicUser` (no persistent user is created) and throwaway directories that were
removed afterwards. Only stub/dummy Claude tokens were used. Production processes were not restarted (PM2 restart
counts unchanged: `wfos-web` 8, `wfos-worker` 7).

## 1. Host facts (read-only inspection)

| Fact | Value | Consequence |
|---|---|---|
| OS / kernel | Ubuntu 24.04.4, 6.8.0-101 | systemd 255, cgroup v2 with `memory cpu pids io` controllers → per-run `MemoryMax`, `CPUQuota`, `TasksMax` available |
| `kernel.apparmor_restrict_unprivileged_userns` | **1** (AppArmor `unprivileged_userns` profile in enforce) | `unshare -Ur` as `nobody` → `write /proc/self/uid_map: Operation not permitted`. **Unprivileged bubblewrap does not work** without an AppArmor profile or a sysctl change |
| `bwrap`, `socat`, `podman`, `runsc`, `docker` | **not installed** | the Agent SDK OS sandbox cannot run as-is (verified, §3) |
| `nft`, `iptables`, `setpriv`, `systemd-run` | present | |
| RAM / CPU / disk | 1967 MB RAM, ~1.0 GB available, **swap 1.7 / 2.0 GB used**; 2 vCPU; 18 GB free disk | the host is already swapping before any agent runs |
| PM2 processes | `wfos-web`, `wfos-worker` and 8 other apps, **all as root** | the worker is privileged; anything it executes on agent-controlled data runs as root |
| `/root` | `700 root` | other users cannot reach `/root/apps/*/.env` |
| `/proc/<pid>/environ` | `400 root`; `kernel.yama.ptrace_scope=1` | other UIDs cannot read the worker's env |
| Redis | 127.0.0.1:6379, **no password** (`default on nopass ~* &* +@all`) | **any local process can read/write production queues and pub/sub** |
| PostgreSQL | listening on **0.0.0.0:5432**, scram-sha-256 for TCP, peer for the Unix socket | reachable from the internet with a password; local users without a matching role are refused |
| Firewall | ufw inactive, `INPUT ACCEPT` | nothing restricts inbound or outbound traffic today |
| Next.js (`wfos-web`) | 127.0.0.1:3010 | reachable by any local process |

## 2. Boundary probe — what an agent command can do

The same probe script (`spike/probe.sh`) ran under two candidate identities. "workspace" means the run's own
directory. The production worker PID (831369) was used for the `/proc` checks.

| Check | **A**: separate unprivileged user only (`nobody`) | **B**: per-run transient systemd unit (hardened, see flags below) |
|---|---|---|
| list `/root` | blocked | blocked |
| read app `.env` (`/root/apps/workforce-os/.env`) | blocked (Permission denied) | blocked |
| read `/proc/<wfos-worker>/environ` | blocked (Permission denied) | blocked (**process invisible**) |
| see other processes / worker cmdline | **visible** | invisible (only its own 3 PIDs) |
| read `/etc/shadow` | blocked | blocked |
| Postgres Unix socket | blocked by peer auth (socket dir visible) | blocked (`InaccessiblePaths`) |
| connect 127.0.0.1:5432 | **ALLOWED** | blocked (Connection refused, own loopback) |
| connect 127.0.0.1:6379 + `PING` | **ALLOWED: `+PONG` from production Redis, no password** | blocked |
| connect 127.0.0.1:3010 | **ALLOWED** | blocked |
| internet (1.1.1.1:443, DNS) | **ALLOWED** | blocked (Network is unreachable, no DNS) |
| write `/etc` | blocked | blocked (read-only FS) |
| write `/root` | blocked | blocked |
| write `/tmp`, `/var/tmp` | allowed, **shared with the host** | allowed, **private to the unit** |
| write workspace | allowed | allowed |
| write `.git/hooks` in workspace | allowed | allowed (expected: it is the agent's own repo; see §6.1) |
| other runs' workspaces | n/a | only its own directory |
| `sudo` / setuid `su` | blocked | blocked (`NoNewPrivileges`) |
| allocate 400 MB | **allowed** | **killed by the cgroup** (`MemoryMax=256M`), unit continued |

Hardening flags of B (all transient, nothing written to `/etc`):
`DynamicUser=yes StateDirectory=… ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes PrivateIPC=yes
ProtectProc=invisible ProcSubset=pid NoNewPrivileges=yes RestrictSUIDSGID=yes CapabilityBoundingSet=
ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes RestrictNamespaces=yes LockPersonality=yes
PrivateNetwork=yes InaccessiblePaths=/run/postgresql InaccessiblePaths=-/run/redis MemoryMax=256M MemorySwapMax=0
OOMPolicy=continue TasksMax=64 CPUQuota=100%`.

**Conclusion of the probe:** a separate UID alone (option a without network isolation) is **not safe on this host**.
It hides files and the worker's env, but leaves production Redis wide open: an agent could read or inject queue jobs,
including approvals. Network isolation is required, not optional.

### Egress allow-list through a Unix socket (tested)

Inside B (`PrivateNetwork=yes`) the only way out is a host-side proxy reached through a **Unix socket** bound into
the unit. A tiny in-unit bridge exposes it as `127.0.0.1:3128` on the unit's **own** loopback (host loopback
services stay unreachable). The proxy accepts only `CONNECT host:443` for allow-listed host names, resolves DNS itself
and refuses private addresses.

| Request from inside the unit | Result |
|---|---|
| `https://example.com` without proxy | `Could not resolve host` |
| `https://api.anthropic.com` without proxy | `Could not resolve host` |
| `https://api.anthropic.com/` via proxy (allow-listed) | **HTTP 404** (reached Anthropic, no credentials sent) |
| `https://example.com/`, `https://github.com/` via proxy | 403 from the proxy (`not allow-listed`) |
| plain `http://api.anthropic.com/` via proxy | 403 (only CONNECT :443) |
| `CONNECT 127.0.0.1:6379` via proxy | 403 |
| `https://169.254.169.254/` via proxy | 403 |

The allow-list is enforced by the OS (network namespace), not by the agent's cooperation. Per-employee domains
(npm, PyPI…) are added to the proxy's list for that run only.

## 3. Agent SDK OS sandbox (`sandbox: { enabled: true }`, bubblewrap)

Tested with SDK 0.3.292 and a stub token:

- **Default (`failIfUnavailable` unset → true): fails closed.** The run ends with
  `error_during_execution: Sandbox required but unavailable: … bubblewrap (bwrap) not installed, socat not installed`
  before `system:init`, so no API request and no command ran.
- **`failIfUnavailable: false`: silently runs unsandboxed.** It only writes a stderr warning (`⚠ Sandbox disabled`),
  then proceeds to the API. Phase 1 must never set this, and a test will assert the runner options.
- On this host bubblewrap would also need `apt install bubblewrap socat`, **and** an AppArmor profile that allows
  `userns` for `/usr/bin/bwrap` (or `kernel.apparmor_restrict_unprivileged_userns=0`, which weakens the whole host).
  Inside unit B, `RestrictNamespaces=yes` would also have to be relaxed for bwrap to work. `enableWeakerNestedSandbox`
  is documented as reducing security and is not needed with the design below.

## 4. Footprint

- One SDK + Claude Code CLI start (init + one API call, stub token), sampled RSS: **~294 MB peak**
  (77 MB SDK host process + 217 MB CLI). A real session with tools will be higher (the brief's 300–500 MB is plausible).
- LibreOffice headless: **not measured** (not installed); typical 150–300 MB per conversion process. To be measured
  in Phase 1.5 before it is enabled.
- With ~1.0 GB available and swap already 85 % used, **this host can run at most one Workspace-mode run at a time**
  (`MemoryMax≈700M`), and even that will push production into swap. Recommended sizes for `docs/DEPLOY.md`:
  4 GB RAM for 1 concurrent Workspace run next to the platform, 8 GB for 2–3.

## 5. Options

| | (a) `wfos-runner` user + SDK sandbox (bwrap) | (b) per-run transient systemd unit | (c) rootless podman / gVisor per run | (d) separate VM |
|---|---|---|---|---|
| Isolation | **Weak alone.** UID separation hides files/env but not the network (Redis `+PONG`, §2). bwrap only wraps Bash commands; the CLI process itself (which holds the token) runs outside it | **Strong for the whole process tree** (CLI + every command + scripts it writes): own UID, own netns, read-only system, private /tmp, invisible /proc, cgroup limits. Shares the kernel | Strong (gVisor: user-space kernel, strongest on one host). Podman: like (b) plus image isolation | Strongest (separate kernel and host) |
| Egress control | bwrap + socat proxy, configured inside the SDK. Requires the sandbox to be available and correctly configured on every call | **OS-enforced**: `PrivateNetwork` + Unix-socket allow-list proxy (tested) | Container network + proxy | VM firewall + proxy |
| Host changes | apt `bubblewrap socat` + AppArmor profile for bwrap (or sysctl), create user, firewall rules for the UID (nftables `skuid`) | **none required** for the boundary (transient units by the root worker). Node/SDK are bind-mounted read-only | apt podman/runsc, rootless podman also needs userns (same AppArmor issue), storage for images (~2–3 GB with the toolchain) | new VM, WireGuard/TLS link, second deploy |
| RAM on this host | ~0 extra | ~0 extra (cgroup accounting only) | + container runtime per run (podman small; gVisor Sentry tens of MB, untested here) | 0 on this host; **a separate 4 GB VM** (cost) |
| Ops complexity | medium (AppArmor + nftables per UID) | **low**: plain `systemd-run` from the worker; same mechanism on any Ubuntu 24.04 | high on 2 GB: images, registry, runtime config | highest (two hosts, networking, secrets) |
| `git clone` + setup-script deploy | yes, with AppArmor/nft steps | **yes**, nothing beyond systemd (always present) | yes, heavy | no (second machine) |
| Docker Compose path | separate runner container | separate runner container with `internal: true` network + proxy container (same proxy code) | n/a (nested) | n/a |

## 6. Recommendation

**Use (b): every Workspace-mode run is its own transient systemd unit, plus a credential-injecting egress gateway.
The worker launches it with `systemd-run`, and the SDK's bubblewrap sandbox stays off.**

1. **Per-run unit** with the flags of B, `DynamicUser=yes` (a fresh UID per run, so runs cannot touch each other),
   the workspace as `StateDirectory=wfos/workspaces/<workspaceId>/<runId>` (persisted for follow-ups and resume;
   systemd re-owns it for the next run), `MemoryMax=700M`, `MemorySwapMax=0`, `TasksMax=256`, `CPUQuota=100%`,
   `RuntimeMaxSec` as a hard wall clock. Stop/cancel = `systemctl stop` → the whole cgroup is killed (no stray
   processes). Concurrency default 1 per host (configurable).
2. **No platform secrets inside, not even the workspace's Claude token.** The CLI honours `ANTHROPIC_BASE_URL`
   (verified against a local stub). It sends `Authorization: Bearer <token>` + `oauth-2025-04-20` beta for
   subscription tokens, or `x-api-key` for API keys. The unit therefore gets a **dummy token** and
   `ANTHROPIC_BASE_URL` pointing at the gateway through the Unix socket. The gateway (in the worker or a small
   `wfos-egress` PM2 process) swaps in the real credential of that run's workspace, forwards only to
   `api.anthropic.com`, and passes the rate-limit headers through (needed in Phase 2). A `printenv` inside the sandbox
   then reveals nothing worth stealing.
3. **Platform tools over a socket.** The `wfos` MCP tools move from the in-process SDK server to an MCP endpoint on
   a per-run Unix socket served by the worker, authenticated with a per-run token. The gate, approvals, taint and
   audit stay in the worker. Postgres and Redis are unreachable from the unit (§2).
4. **Egress allow-list** = the gateway's list: `api.anthropic.com` always, plus per-employee domains (package
   registries for Developer). Everything else gets a 403, and all outbound traffic passes through this one choke point.
5. **Bash classifier (1.3) on top** decides *approval*. The unit decides *what is even possible*. A script the
   agent wrote and then runs is judged by the unit's limits, whatever its name (write-then-run).
6. **SDK `sandbox` stays off**, with a test asserting `failIfUnavailable` is never `false`. Turning bwrap on inside the
   unit would require relaxing `RestrictNamespaces` and changing AppArmor host-wide, for no gain over the unit boundary.

### Changes to the brief's 1.2 wording (needs your OK)

- The brief describes "a `wfos-runner` PM2 process running as an unprivileged `wfos-runner` user". With (b) there is
  no long-lived runner process: each run is a short-lived unit with its own dynamic UID, started by the (root) worker.
  A long-lived unprivileged runner would either share one UID across all runs (runs could tamper with each other) or
  need polkit rights to start arbitrary units (equivalent to root). If you prefer a named PM2 entry, `wfos-runner`
  can be a small root launcher that only accepts "start run X" over a socket from the worker.
- `/var/lib/wfos/workspaces/<workspaceId>/<runId>` becomes `/var/lib/private/wfos/workspaces/...`, which is where
  systemd keeps `DynamicUser` state.

### 6.1 Git delivery (input for Phase 1.4)

The agent can write `.git/hooks` and `.git/config` in its workspace. That is fine inside the unit, but **the worker
runs as root** and must never run git with that workspace as its repository. Repo-local config (`core.fsmonitor`,
`core.sshCommand`, filter drivers, hooks) would execute as root. Plan: the push happens from a platform-owned bare
repository. Commits are fetched into it with `GIT_CONFIG_NOSYSTEM=1 -c core.hooksPath=/dev/null` inside another
hardened unit, never from the workspace's `.git` directly. The approval card shows this.

## 7. What needs your approval before Phase 1 (nothing has been run)

Required for the recommended design: **none**. Transient units, bind mounts of the existing Node runtime
(`/root/.nvm/versions/node/v24.14.1` → `/opt/node`, read-only, tested) and the SDK package (read-only) work as they are.

Required later (Phase 1.5 toolchain), to be listed again with exact versions then:
`apt-get install -y libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui pandoc poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-ind python3-venv`
(adds roughly 600–900 MB of disk; RAM only while a conversion runs).

**Strongly recommended now, independent of this upgrade (security findings):**

1. **Redis has no password** and is reachable by every local process (proved: `+PONG` from `nobody`).
   ```
   redis-cli CONFIG SET requirepass '<random>' && redis-cli CONFIG REWRITE
   # then REDIS_URL=redis://:<random>@127.0.0.1:6379/3 in /root/apps/workforce-os/.env and pm2 reload wfos-web wfos-worker
   ```
   Impact: every Redis client on this host (including other apps that may share this Redis) needs the password.
2. **PostgreSQL listens on 0.0.0.0 and there is no firewall.** It is password-protected (scram), but it is exposed to the
   internet. Either `listen_addresses = 'localhost'` in `/etc/postgresql/16/main/postgresql.conf` + `systemctl restart
   postgresql` (check that no other app connects remotely first), or enable ufw:
   ```
   ufw default deny incoming && ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
   ```
   Impact: blocks every other inbound port. Check the other PM2 apps' ports first.

Optional (only if you want bwrap as an extra layer, **not recommended**, see §3):
`apt-get install -y bubblewrap socat` plus an AppArmor profile `/etc/apparmor.d/bwrap` granting `userns,` to
`/usr/bin/bwrap`. Impact: any local user can then create user namespaces through bwrap.

## Appendix — evidence

Scripts in `docs/upgrade/spike/` (reproducible on any Ubuntu 24.04 host with systemd 255):

- `probe.sh`: one line per check (`ALLOWED`/`blocked`); reads print byte counts only, never contents.
- `probe-results.txt`: the A/B output from 2026-10-08.
- `proxy.mjs`, `bridge.mjs`, `egress-probe.sh`: Unix-socket CONNECT allow-list proxy, in-unit loopback bridge, test.
- `sdk-failclosed.mjs`: `sandbox: { enabled: true }` with and without `failIfUnavailable: false`, stub token.
- `sdk-baseurl.mjs`, `stub-api.mjs`: the CLI against a local stub API to see which credential headers it sends.
