import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, setClaudeCredential } from "@wfos/db";
import { CLAUDE_LOGIN_CODE_RE, CLAUDE_LOGIN_MINUTES, claudeLoginKey, type ClaudeLoginState } from "@wfos/shared";
import { env } from "./lib/env";
import { errorMessage } from "./lib/errors";
import { log } from "./lib/logger";
import { redis } from "./lib/redis";
import { defaultSandboxHost } from "./runner/workspace/layout";

/*
 * "Connect Claude" (after AIRIS 8314578, reworked for many workspaces). AIRIS logs the one server-wide CLI in; here each
 * workspace gets its own token: the worker runs `claude setup-token` in a pseudo-terminal with a throw-away HOME, hands
 * the sign-in link to the web through Redis, forwards the code the Owner pastes, and stores the printed 1-year token as
 * that workspace's credential (encrypted, like a pasted one). The token never reaches Redis, logs or the browser; the
 * HOME is wiped afterwards. Runs keep going through the credential gateway unchanged.
 */

/** sign-ins at once across all workspaces (each is one idle CLI process) */
const MAX_SESSIONS = 3;
const LINK_WAIT_MS = 30_000;
const VERIFY_WAIT_MS = 60_000;
/** how long a finished state stays readable for the page that polls it */
const DONE_TTL_S = 300;
const HOME_PREFIX = "wfos-claude-login-";
const LINK_HOSTS = new Set(["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"]);

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Terminal output without escape sequences (hyperlinks, cursor moves, colours). */
export function plainText(out: string): string {
  return out.replace(OSC, "").replace(CSI, "").replace(/\x1b[78]/g, "");
}

/** The sign-in link the CLI printed (an OSC 8 hyperlink, else plain text); only a claude.com/anthropic.com authorize URL. */
export function loginUrlOf(out: string): string | null {
  const m = out.match(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b\s]+)/) ?? plainText(out).match(/https:\/\/\S+\/oauth\/authorize\?\S+/);
  if (!m) return null;
  try {
    const u = new URL(m[1] ?? m[0]);
    return u.protocol === "https:" && LINK_HOSTS.has(u.hostname) && u.pathname.endsWith("/oauth/authorize") ? u.toString() : null;
  } catch {
    return null;
  }
}

export function tokenOf(out: string): string | null {
  return plainText(out).match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/)?.[0] ?? null;
}

interface Session {
  workspaceId: string;
  userId: string;
  email: string;
  state: ClaudeLoginState;
  proc: ChildProcess;
  home: string;
  out: string;
  /** output length when the code was sent: errors are looked for after it */
  codeAt: number;
  timers: NodeJS.Timeout[];
  finished: boolean;
}

const sessions = new Map<string, Session>();

function claudeBin(): string {
  return process.env.WFOS_CLAUDE_LOGIN_BIN ?? path.join(defaultSandboxHost().claudeDir, "claude");
}

async function writeState(workspaceId: string, state: ClaudeLoginState, ttl: number): Promise<void> {
  await redis.set(claudeLoginKey(workspaceId, env.namespace), JSON.stringify(state), "EX", ttl);
}

/** Only the workspace's current session writes; a cancelled or replaced one stays silent. */
async function save(s: Session, patch: Partial<ClaudeLoginState>): Promise<void> {
  if (s.finished || sessions.get(s.workspaceId) !== s) return;
  s.state = { ...s.state, ...patch };
  const done = s.state.status === "connected" || s.state.status === "failed";
  await writeState(s.workspaceId, s.state, done ? DONE_TTL_S : CLAUDE_LOGIN_MINUTES * 60 + 60);
}

function end(s: Session): void {
  if (s.finished) return;
  s.finished = true;
  for (const t of s.timers) clearTimeout(t);
  if (sessions.get(s.workspaceId) === s) sessions.delete(s.workspaceId);
  if (s.proc.exitCode === null && s.proc.pid) {
    try {
      process.kill(-s.proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  void rm(s.home, { recursive: true, force: true }).catch(() => undefined);
}

async function fail(s: Session, error: NonNullable<ClaudeLoginState["error"]>): Promise<void> {
  if (s.finished) return;
  log.warn({ workspaceId: s.workspaceId, error, tail: s.state.status === "starting" ? plainText(s.out).slice(-300) : undefined }, "claude sign-in failed");
  await save(s, { status: "failed", error }).catch(() => undefined);
  end(s);
}

async function connected(s: Session, token: string): Promise<void> {
  if (s.finished) return;
  try {
    await setClaudeCredential(s.workspaceId, "oauth", token);
    await audit({
      workspaceId: s.workspaceId,
      actorUserId: s.userId,
      actorLabel: s.email,
      action: "credential.claude_set",
      targetType: "workspace",
      targetId: s.workspaceId,
      details: { type: "oauth", last4: token.slice(-4), via: "connect" },
    });
    await save(s, { status: "connected", last4: token.slice(-4) });
    log.info({ workspaceId: s.workspaceId }, "claude connected from settings");
    end(s);
  } catch (e) {
    log.error({ workspaceId: s.workspaceId, err: errorMessage(e) }, "storing the claude token failed");
    await fail(s, "cli_failed");
  }
}

export async function startClaudeLogin(m: { workspaceId: string; sessionId: string; userId: string; email: string }): Promise<void> {
  const prev = sessions.get(m.workspaceId);
  if (prev) end(prev);
  const now = Date.now();
  const state: ClaudeLoginState = {
    id: m.sessionId,
    status: "starting",
    url: null,
    error: null,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAUDE_LOGIN_MINUTES * 60_000).toISOString(),
    last4: null,
  };
  if (sessions.size >= MAX_SESSIONS) {
    await writeState(m.workspaceId, { ...state, status: "failed", error: "busy" }, DONE_TTL_S);
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), HOME_PREFIX));
  // `script` gives the CLI a terminal (it prints the link and reads the code); a wide one keeps link and token on one
  // line; `timeout` ends the CLI even if this worker dies and nobody kills it
  const proc = spawn("script", ["-qfec", `stty cols 2000 rows 50 2>/dev/null; exec timeout ${CLAUDE_LOGIN_MINUTES + 1}m "$WFOS_CLAUDE_BIN" setup-token`, "/dev/null"], {
    cwd: home,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm", WFOS_CLAUDE_BIN: claudeBin() },
  });
  const s: Session = { ...m, state, proc, home, out: "", codeAt: 0, timers: [], finished: false };
  sessions.set(m.workspaceId, s);
  await save(s, {});

  const onData = (d: Buffer) => {
    if (s.finished) return;
    s.out = (s.out + d.toString("utf8")).slice(-65_536);
    if (s.state.status === "starting") {
      const url = loginUrlOf(s.out);
      if (url) void save(s, { status: "awaiting_code", url });
    } else if (s.state.status === "verifying") {
      const token = tokenOf(s.out);
      if (token) void connected(s, token);
      else if (/invalid|expired|error/i.test(plainText(s.out.slice(s.codeAt)))) void fail(s, "invalid_code");
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", () => void fail(s, "cli_failed"));
  proc.on("exit", () => {
    if (s.finished) return;
    const token = s.state.status === "verifying" ? tokenOf(s.out) : null;
    if (token) void connected(s, token);
    else void fail(s, s.state.status === "verifying" ? "invalid_code" : s.state.status === "starting" ? "no_link" : "cli_failed");
  });
  s.timers.push(
    setTimeout(() => s.state.status === "starting" && void fail(s, "no_link"), LINK_WAIT_MS),
    setTimeout(() => void fail(s, "timeout"), CLAUDE_LOGIN_MINUTES * 60_000),
  );
}

export async function submitClaudeLoginCode(m: { workspaceId: string; sessionId: string; code: string }): Promise<void> {
  const s = sessions.get(m.workspaceId);
  if (!s || s.state.id !== m.sessionId || s.state.status !== "awaiting_code") return;
  const code = m.code.trim();
  if (!CLAUDE_LOGIN_CODE_RE.test(code)) return void fail(s, "invalid_code");
  s.codeAt = s.out.length;
  await save(s, { status: "verifying" });
  s.proc.stdin?.write(`${code}\r`);
  s.timers.push(setTimeout(() => s.state.status === "verifying" && void fail(s, "invalid_code"), VERIFY_WAIT_MS));
}

/** The Owner closed the dialog: stop the CLI and forget the state (unless a newer sign-in replaced it). */
export async function cancelClaudeLogin(m: { workspaceId: string; sessionId: string }): Promise<void> {
  const s = sessions.get(m.workspaceId);
  if (s && s.state.id === m.sessionId) end(s);
  const key = claudeLoginKey(m.workspaceId, env.namespace);
  const raw = await redis.get(key);
  if (raw && (JSON.parse(raw) as ClaudeLoginState).id === m.sessionId) await redis.del(key);
}

/** Worker start: sign-ins of a previous worker process cannot finish; say so and remove their HOMEs. */
export async function recoverClaudeLogins(workspaceIds: string[]): Promise<void> {
  for (const ws of workspaceIds) {
    const raw = await redis.get(claudeLoginKey(ws, env.namespace));
    if (!raw) continue;
    const st = JSON.parse(raw) as ClaudeLoginState;
    if (st.status !== "connected" && st.status !== "failed") await writeState(ws, { ...st, status: "failed", error: "worker_restarted" }, DONE_TTL_S);
  }
  const dir = tmpdir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(HOME_PREFIX)) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

export function stopClaudeLogins(): void {
  for (const s of [...sessions.values()]) end(s);
}

/** test hook */
export function activeClaudeLogins(): number {
  return sessions.size;
}
