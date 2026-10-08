import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { SANDBOX, type RunLayout, type SandboxHost } from "./layout";

const exec = promisify(execFile);

export interface UnitLimits {
  memoryMaxMb: number;
  tasksMax: number;
  cpuQuotaPercent: number;
  runtimeMaxSec: number;
}

export const DEFAULT_LIMITS: UnitLimits = {
  memoryMaxMb: Number(process.env.WORKSPACE_MEMORY_MAX_MB ?? 700),
  tasksMax: Number(process.env.WORKSPACE_TASKS_MAX ?? 256),
  cpuQuotaPercent: Number(process.env.WORKSPACE_CPU_QUOTA ?? 100),
  runtimeMaxSec: Number(process.env.WORKSPACE_RUNTIME_MAX_SEC ?? 3600),
};

/**
 * The isolation of a Workspace-mode run, as systemd properties. Pure, so tests can assert every flag.
 * See docs/upgrade/SPIKE-sandbox.md for what each one blocks (measured on the production host).
 */
/** Extra read-only mounts under /mnt/wfos (e.g. the platform's bare repository mirror). */
export interface ExtraBind {
  host: string;
  sandbox: string;
}

export function unitProperties(host: SandboxHost, layout: RunLayout, limits: UnitLimits = DEFAULT_LIMITS, workDir = layout.sandboxRepoDir, extraBinds: ExtraBind[] = []): string[] {
  for (const b of extraBinds) if (!b.sandbox.startsWith("/mnt/wfos/")) throw new Error("extra binds must live under /mnt/wfos");
  return [
    // identity: a dynamic UID, stable per task, never root
    "DynamicUser=yes",
    `User=${layout.userName}`,
    `StateDirectory=${layout.stateRel}`,
    "StateDirectoryMode=0700",
    `WorkingDirectory=${workDir}`,
    "UMask=0077",
    // filesystem: read-only system, no /root or /home, private /tmp, no devices, platform paths hidden
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "InaccessiblePaths=-/run/postgresql",
    "InaccessiblePaths=-/var/run/postgresql",
    "InaccessiblePaths=-/run/redis",
    `InaccessiblePaths=-${host.runtimeDir}`,
    "InaccessiblePaths=-/etc/postgresql",
    "InaccessiblePaths=-/etc/redis",
    // platform files on a unit-private tmpfs; mount points are created there, never on the host
    `TemporaryFileSystem=${SANDBOX.mountRoot}`,
    `BindReadOnlyPaths=${host.nodePrefix}:${SANDBOX.nodeDir}`,
    `BindReadOnlyPaths=${host.runnerDir}:/mnt/wfos/runner`,
    `BindReadOnlyPaths=-${host.claudeDir}:/mnt/wfos/claude`,
    `BindPaths=${layout.hostSocketDir}:${SANDBOX.socketDir}`,
    ...extraBinds.map((b) => `BindReadOnlyPaths=${b.host}:${b.sandbox}`),
    // privileges
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "SystemCallArchitectures=native",
    // network: own namespace (own loopback); the only ways out are the sockets in /run/wfos-run
    "PrivateNetwork=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    // resources
    `MemoryMax=${limits.memoryMaxMb}M`,
    "MemorySwapMax=0",
    `TasksMax=${limits.tasksMax}`,
    `CPUQuota=${limits.cpuQuotaPercent}%`,
    `RuntimeMaxSec=${limits.runtimeMaxSec}`,
    "OOMPolicy=kill",
    "KillMode=control-group",
    "TimeoutStopSec=10",
  ];
}

export interface LaunchOptions {
  host: SandboxHost;
  layout: RunLayout;
  limits?: UnitLimits;
  env: Record<string, string>;
  command: string[];
  workDir?: string;
  extraBinds?: ExtraBind[];
}

/** Start the unit and wait for it (systemd-run --wait). stdout/stderr of the unit come back on the pipes. */
export function launchUnit(o: LaunchOptions): ChildProcess {
  // bind sources must exist, or systemd fails the unit with EXIT_NAMESPACE (226)
  mkdirSync(o.layout.hostSocketDir, { recursive: true, mode: 0o755 });
  const args = ["--quiet", "--collect", "--wait", "--pipe", "--service-type=exec", `--unit=${o.layout.unitName}`];
  for (const p of unitProperties(o.host, o.layout, o.limits, o.workDir, o.extraBinds)) args.push("-p", p);
  for (const [k, v] of Object.entries(o.env)) args.push(`--setenv=${k}=${v}`);
  args.push(...o.command);
  return spawn("systemd-run", args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** Stop a run: kills the whole cgroup (agent, every command it started, every child). */
export async function stopUnit(unitName: string): Promise<void> {
  await exec("systemctl", ["stop", `${unitName}.service`], { timeout: 20_000 }).catch(() => {});
}

export async function unitActive(unitName: string): Promise<boolean> {
  const r = await exec("systemctl", ["is-active", `${unitName}.service`]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  return String(r.stdout).trim() === "active";
}
