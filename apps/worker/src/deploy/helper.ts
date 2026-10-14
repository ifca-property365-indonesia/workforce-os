import { HELPER_PATH, sshExec, type SshExecResult, type SshTarget } from "@wfos/shared/ssh";

/**
 * The root helper on an app server (`sudo -n /usr/local/sbin/wfos-app-helper <cmd> <args…>`, contract A2 §1).
 * Exit 0 ok · 1 failed · 2 bad arguments (also memory over half the server's) · 3 refused by a guard; reasons are
 * printed on stderr as `wfos-app-helper: <code>: <detail>`.
 * Secrets (env, passwords, htpasswd line) and command lines only ever travel on stdin, never as arguments.
 */

export const HELPER_EXIT_FAILED = 1;
export const HELPER_EXIT_BAD_ARGS = 2;
export const HELPER_EXIT_GUARD = 3;
/** codes the helper prints as `wfos-app-helper: <code>: <detail>` (exit 3, backup_missing with exit 1) */
const CODES = ["disk_low", "release_missing", "release_active", "bad_archive", "server_name_taken", "cert_limit", "firewall_off", "server_full", "backup_missing", "port_busy", "legacy_active"] as const;
export type HelperGuard = (typeof CODES)[number];
const CODE_TEXT: Record<HelperGuard, string> = {
  disk_low: "the server has too little free disk space",
  release_missing: "the release folder is not on the server",
  release_active: "that release is the one running now",
  bad_archive: "the release archive was refused (unsafe or too large)",
  server_name_taken: "another site on the server already uses this domain",
  cert_limit: "the daily limit of new certificates on this server is reached",
  firewall_off: "the app firewall is not loaded on the server; the Owner should start wfos-apps-firewall.service or re-run prepare.sh",
  server_full: "the server already runs (or holds) as many apps as it allows",
  backup_missing: "the database backup is not on the server",
  port_busy: "another running unit of the server uses that port",
  legacy_active: "the live environment's single (helper v3) unit still runs on the blue slot's port",
};

/** Arguments are slugs, shas, numbers, paths and flags: anything else is a bug here, never sent. */
const ARG_RE = /^[A-Za-z0-9._/:-]{1,200}$/;

export class HelperError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    /** the helper's reason code (a guard on exit 3, backup_missing on exit 1) */
    readonly guard: HelperGuard | null,
    /** the helper's last output lines (redact before storing) */
    readonly detail: string,
  ) {
    super(
      guard
        ? `${command}: ${CODE_TEXT[guard]} (${guard})${detail ? `: ${detail}` : ""}`
        : exitCode === HELPER_EXIT_BAD_ARGS
          ? `${command}: the helper refused the arguments${detail ? ` (${detail})` : ""}`
          : `${command} failed (exit ${exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "HelperError";
  }
}

/** Codes that become the app's statusMessage (the Owner has to act on the server, or free a slot). */
export const STATUS_CODES = ["firewall_off", "server_full"] as const;
export function statusCodeOf(e: unknown): (typeof STATUS_CODES)[number] | null {
  return e instanceof HelperError && e.guard && (STATUS_CODES as readonly string[]).includes(e.guard) ? (e.guard as (typeof STATUS_CODES)[number]) : null;
}

/** The reason code in the helper's stderr (`wfos-app-helper: <code>: …`), if it printed one of ours. */
export function helperCode(stderr: string): HelperGuard | null {
  for (const line of stderr.split("\n").reverse()) {
    const m = /^wfos-app-helper: ([a-z_]+):/.exec(line.trim());
    if (m && (CODES as readonly string[]).includes(m[1]!)) return m[1] as HelperGuard;
  }
  return null;
}

export interface HelperOptions {
  stdin?: string;
  timeoutMs?: number;
  onData?: (chunk: string) => void;
  maxOutputBytes?: number;
}

export function helperCommand(cmd: string, args: (string | number)[]): string {
  if (!/^[a-z][a-z-]{1,30}$/.test(cmd)) throw new Error(`invalid helper command ${cmd}`);
  const parts = args.map(String);
  for (const a of parts) if (!ARG_RE.test(a)) throw new Error(`invalid helper argument for ${cmd}`);
  return [`sudo -n ${HELPER_PATH}`, cmd, ...parts.map((a) => `'${a}'`)].join(" ");
}

/** The last few lines of output, for an error message. */
export function outputTail(r: Pick<SshExecResult, "stdout" | "stderr">, lines = 3): string {
  return (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-lines).join(" ").slice(0, 400);
}

/** Run a helper command; the result whatever the exit code (SSH errors throw). */
export async function helperCall(t: SshTarget, cmd: string, args: (string | number)[], o: HelperOptions = {}): Promise<SshExecResult> {
  return sshExec(t, helperCommand(cmd, args), { stdin: o.stdin, timeoutMs: o.timeoutMs ?? 120_000, onData: o.onData, maxOutputBytes: o.maxOutputBytes });
}

/** Run a helper command; HelperError unless it exits 0. */
export async function helper(t: SshTarget, cmd: string, args: (string | number)[], o: HelperOptions = {}): Promise<SshExecResult> {
  const r = await helperCall(t, cmd, args, o);
  if (r.code === 0) return r;
  throw new HelperError(cmd, r.code, r.code === HELPER_EXIT_GUARD || r.code === HELPER_EXIT_FAILED ? helperCode(r.stderr) : null, outputTail(r));
}
