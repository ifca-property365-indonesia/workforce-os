import "server-only";
import { access, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, getOrCreateWorkspaceSshKey, servers, workspaceSshPrivateKey, workspaces } from "@wfos/db";
import { WFOS_HELPER_VERSION, type ServerInfo } from "@wfos/shared";
import { isBlockedAddress } from "@wfos/shared/netguard";
import { HelperOutdatedError, probeServer, sshErrorCode, type SshTarget } from "@wfos/shared/ssh";
import { HttpError } from "./auth";
import { serverEnv } from "./env";
import { logger } from "./logger";
import { notFound } from "./route";

export type ServerRow = typeof servers.$inferSelect;

/** What the browser may see: everything but the pinned key blob (the fingerprint identifies it). */
export function serverDTO(s: ServerRow) {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    role: s.role,
    baseDomain: s.baseDomain,
    hostKeyAlgo: s.hostKeyAlgo,
    hostKeyFingerprint: s.hostKeyFingerprint,
    status: s.status,
    /** an error code (servers.error.<code> in the UI), null when fine */
    statusMessage: s.statusMessage,
    maxRunningApps: s.maxRunningApps,
    info: s.info,
    lastCheckedAt: s.lastCheckedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
export type ServerDTO = ReturnType<typeof serverDTO>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadServer(workspaceId: string, id: string): Promise<ServerRow> {
  if (!UUID_RE.test(id)) notFound("server_not_found");
  const [s] = await db.select().from(servers).where(and(eq(servers.id, id), eq(servers.workspaceId, workspaceId)));
  if (!s) notFound("server_not_found");
  return s;
}

/** A literal private/loopback address (or localhost) is refused at registration unless the instance allows it. */
export function assertHostAllowed(host: string) {
  if (serverEnv.appServersAllowPrivate) return;
  const h = host.toLowerCase().replace(/\.$/, "");
  const local = h === "localhost" || h.endsWith(".localhost");
  if (local || (isIP(h) && isBlockedAddress(h))) {
    throw new HttpError(400, "This address is private; this instance only allows public servers", { code: "server_host_not_allowed" });
  }
}

/** Unique name / domain per workspace: 409 with a code the form can show. */
export async function assertUnique(workspaceId: string, v: { name?: string; baseDomain?: string }, exceptId?: string) {
  const rows = await db.select({ id: servers.id, name: servers.name, baseDomain: servers.baseDomain }).from(servers).where(eq(servers.workspaceId, workspaceId));
  const others = rows.filter((r) => r.id !== exceptId);
  if (v.name !== undefined && others.some((r) => r.name === v.name)) throw new HttpError(409, "A server with this name already exists", { code: "server_name_taken" });
  if (v.baseDomain !== undefined && others.some((r) => r.baseDomain === v.baseDomain)) {
    throw new HttpError(409, "Another server already uses this domain", { code: "server_domain_taken" });
  }
}

/** A concurrent duplicate caught by the unique indexes (after assertUnique passed): the same 409s. */
export function duplicateError(e: unknown): HttpError | null {
  const err = (e as { cause?: unknown })?.cause ?? e;
  const pg = err as { code?: string; constraint_name?: string };
  if (pg?.code !== "23505") return null;
  if (pg.constraint_name === "servers_ws_domain") return new HttpError(409, "Another server already uses this domain", { code: "server_domain_taken" });
  return new HttpError(409, "A server with this name already exists", { code: "server_name_taken" });
}

/** The workspace key's public half (the pair is created on first use). The private key stays on the server side. */
export async function workspaceKey(workspaceId: string) {
  const [ws] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return getOrCreateWorkspaceSshKey(db, workspaceId, ws?.slug ?? "workspace");
}

/** POSIX single-quoted shell word. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The line the Owner runs as root on the new server, next to prepare.sh and wfos-app-helper. */
export function prepareCommand(publicKey: string, server?: Pick<ServerRow, "baseDomain" | "username"> | null): string {
  const domain = server?.baseDomain ?? "preview.example.com";
  const user = server && server.username !== "wfos-apps" ? ` --user ${shellQuote(server.username)}` : "";
  // i18n-ignore: a shell command, the same in every language
  return `sudo bash prepare.sh --public-key ${shellQuote(publicKey)} --domain ${shellQuote(domain)}${user}`;
}

/** The scripts the Owner copies to a server, in the order they are shown. */
export const PREPARE_FILES = ["prepare.sh", "wfos-app-helper"] as const;

/**
 * deploy/app-server in the repository. The web app runs with its own folder as the working directory (pnpm dev,
 * `next start` under PM2, the Docker image), so the repository root is two levels up; tests run there too.
 * The files are read at runtime from the checkout (turbopackIgnore: not traced into the build output).
 */
export async function prepareScriptDir(): Promise<string | null> {
  const cwd = process.cwd();
  const candidates = [path.resolve(/*turbopackIgnore: true*/ cwd, "..", "..", "deploy", "app-server"), path.resolve(/*turbopackIgnore: true*/ cwd, "deploy", "app-server")];
  for (const dir of candidates) {
    try {
      await access(path.join(/*turbopackIgnore: true*/ dir, PREPARE_FILES[0]));
      return dir;
    } catch {
      // try the next one
    }
  }
  return null;
}

export async function readPrepareFiles(): Promise<{ name: string; content: string }[] | null> {
  const dir = await prepareScriptDir();
  if (!dir) return null;
  try {
    return await Promise.all(PREPARE_FILES.map(async (name) => ({ name, content: await readFile(path.join(/*turbopackIgnore: true*/ dir, name), "utf8") })));
  } catch {
    return null;
  }
}

/** SSH failures as HTTP errors (nothing stored). */
export function sshHttpError(e: unknown): HttpError {
  const code = sshErrorCode(e);
  switch (code) {
    case "server_host_not_allowed":
      return new HttpError(400, "This address is not allowed", { code: "server_host_not_allowed" });
    case "host_key_mismatch":
      return new HttpError(409, "The server presented a different host key", { code: "host_key_mismatch" });
    case "ssh_auth_failed":
      return new HttpError(502, "The server refused the workspace key", { code: "ssh_auth_failed" });
    case "ssh_unreachable":
      return new HttpError(502, "The server could not be reached", { code: "ssh_unreachable" });
    case "helper_missing":
      return new HttpError(502, "The helper is not installed", { code: "helper_missing" });
    case "helper_outdated":
      return new HttpError(409, "The helper is outdated", { code: "helper_outdated" });
    default:
      logger.warn({ err: (e as Error)?.message }, "server ssh error");
      return new HttpError(502, "The SSH connection failed", { code: "ssh_failed" });
  }
}

/** Probe outcome: ready, or the code that explains the error. */
export function judgeInfo(info: ServerInfo, baseDomain: string): string | null {
  if (info.helperVersion < WFOS_HELPER_VERSION) return "helper_outdated";
  if (info.baseDomain.toLowerCase().replace(/\.$/, "") !== baseDomain.toLowerCase()) return "server_domain_mismatch";
  return null;
}

/**
 * Connect with the pinned host key and the workspace key, run the helper's `info`, and store the result:
 * status ready, or error with a code. The caller has checked that a key is pinned.
 */
export async function probeAndRecord(s: ServerRow): Promise<ServerRow> {
  if (!s.hostKey || !s.hostKeyAlgo) throw new HttpError(409, "Verify the server first", { code: "server_not_verified" });
  await workspaceKey(s.workspaceId);
  const privateKey = await workspaceSshPrivateKey(db, s.workspaceId);
  if (!privateKey) throw new Error("workspace SSH key missing after creation");
  const target: SshTarget = {
    host: s.host,
    port: s.port,
    username: s.username,
    privateKey,
    hostKeyAlgo: s.hostKeyAlgo,
    hostKey: s.hostKey,
    allowPrivate: serverEnv.appServersAllowPrivate,
  };
  let info: ServerInfo | null = null;
  let code: string | null;
  try {
    info = await probeServer(target);
    code = judgeInfo(info, s.baseDomain);
  } catch (e) {
    code = sshErrorCode(e);
    // an outdated helper still reported what it knows
    if (e instanceof HelperOutdatedError) info = e.info;
    if (code === "unknown") logger.warn({ err: (e as Error)?.message, serverId: s.id }, "server probe failed");
  }
  const [row] = await db
    .update(servers)
    .set({ status: code ? "error" : "ready", statusMessage: code, ...(info ? { info } : {}), lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(servers.id, s.id))
    .returning();
  return row!;
}
