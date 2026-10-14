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

/**
 * Default memory of one sandbox unit. Claude Code (300-500 MB) plus what it runs (pnpm install, tsc, next build) share
 * it, and MemorySwapMax=0: 700 MB was OOM-killed by a plain `pnpm install` + `tsc` in production. Concurrency × this
 * must fit the host's free memory (see .env.example).
 */
export const DEFAULT_MEMORY_MAX_MB = 2048;

export const DEFAULT_LIMITS: UnitLimits = {
  memoryMaxMb: Number(process.env.WORKSPACE_MEMORY_MAX_MB || DEFAULT_MEMORY_MAX_MB),
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
    // "-": a workspace the agent emptied must not stop the unit (root never recreates paths inside it)
    `WorkingDirectory=-${workDir}`,
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

/** systemd's journal message "Failed with result '<result>'" (SD_MESSAGE_UNIT_FAILURE_RESULT), with UNIT_RESULT set. */
const UNIT_FAILURE_RESULT = "d9b373ed55a64feb8242e02dbe79a49c";
/** "The kernel OOM killer killed some processes in this unit." (SD_MESSAGE_UNIT_OUT_OF_MEMORY) */
const UNIT_OUT_OF_MEMORY = "fe6faa94e7774663a0da52717891d8ef";

/**
 * How a unit ended, from systemd's own journal entries for it (`journalctl -u <unit> -o json`): "oom-kill", "timeout",
 * "exit-code", "signal", … or null when the journal has no failure entry. Only entries written by PID 1 count (the
 * sandbox can log to journald too, but cannot fake _PID, a trusted field). An OOM kill wins over any other result:
 * with OOMPolicy=kill the unit's result is oom-kill, but an earlier kill of a child is reported the same way.
 */
export function parseUnitEnd(journalJson: string): string | null {
  let result: string | null = null;
  let oom = false;
  for (const line of journalJson.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e._PID !== "1") continue;
    if (e.MESSAGE_ID === UNIT_OUT_OF_MEMORY) oom = true;
    if (typeof e.UNIT_RESULT === "string" && (e.MESSAGE_ID === UNIT_FAILURE_RESULT || e.MESSAGE_ID === undefined)) result = e.UNIT_RESULT;
  }
  return oom ? "oom-kill" : result;
}

export type JournalReader = (unitName: string) => Promise<string>;

const readJournal: JournalReader = async (unitName) =>
  String((await exec("journalctl", ["-u", `${unitName}.service`, "-o", "json", "--no-pager", "-q"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout);

/**
 * Why a unit that exited non-zero ended. `systemd-run --wait` exits 1 for every non-"exit-code" result (oom-kill,
 * timeout, …) and the unit is collected right away (--collect), so `systemctl show -p Result` no longer knows it:
 * systemd's journal entry for the unit is the durable record. journald writes asynchronously, so a missing entry is
 * read again a few times. Never throws (null: unknown).
 */
export async function unitEndResult(unitName: string, o: { read?: JournalReader; attempts?: number; delayMs?: number } = {}): Promise<string | null> {
  const read = o.read ?? readJournal;
  const attempts = o.attempts ?? 4;
  for (let i = 0; i < attempts; i++) {
    const r = await read(unitName).then(parseUnitEnd, () => null);
    if (r) return r;
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, o.delayMs ?? 250));
  }
  return null;
}

/** The sandbox unit was killed for exceeding its memory limit (MemoryMax, no swap). */
export class SandboxOutOfMemoryError extends Error {
  constructor(
    readonly memoryMaxMb: number,
    detail = "",
  ) {
    super(
      `Sandbox ran out of memory (limit ${memoryMaxMb} MB): the kernel killed the run while it or a command it started (e.g. an install or a build) used more. ` +
        `Retrying needs more memory (WORKSPACE_MEMORY_MAX_MB) or lighter steps (one build at a time, no parallel installs).${detail ? ` Last output: ${detail}` : ""}`,
    );
    this.name = "SandboxOutOfMemoryError";
  }
}

/** A clear error for a unit that ended non-zero, from its systemd result (null: no better explanation than the exit code). */
export function unitFailureError(result: string | null, limits: UnitLimits, detail: string): Error | null {
  if (result === "oom-kill") return new SandboxOutOfMemoryError(limits.memoryMaxMb, detail);
  if (result === "timeout") return new Error(`Sandbox reached its runtime limit (${limits.runtimeMaxSec} s) and was stopped.${detail ? ` Last output: ${detail}` : ""}`);
  return null;
}
