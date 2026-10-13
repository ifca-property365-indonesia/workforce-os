import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, members, servers, workspaces, workspaceSshPrivateKey } from "@wfos/db";
import type { ServerInfo, ServerStatus } from "@wfos/shared";
import { MESSAGE_CATALOG, msg, type MessageKey } from "@wfos/shared/messages";
import { HelperOutdatedError, probeServer, sshErrorCode } from "@wfos/shared/ssh";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { miscQueue, publish } from "../lib/redis";

/** How often index.ts looks for servers due a re-check. */
export const SERVER_RECHECK_TICK_MS = 10 * 60_000;
/** A verified server is probed again when its last check is at least this old (hourly). */
export const SERVER_RECHECK_EVERY_MS = 60 * 60_000;
/** Servers probed per tick at most (one after another: a probe takes up to ~45 s when the server is down). */
const RECHECK_BATCH = 20;

type Server = typeof servers.$inferSelect;

export interface RecheckOutcome {
  serverId: string;
  status: ServerStatus;
  /** error code (sshErrorCode, or server_domain_mismatch) when status is error */
  code: string | null;
  /** went ready → error with this check: the Owners were notified */
  wentDown: boolean;
}

/** Probe one server with its pinned key. Never throws: the outcome is the new status and error code. */
async function probe(s: Server): Promise<{ status: ServerStatus; code: string | null; info: ServerInfo | null }> {
  try {
    const privateKey = await workspaceSshPrivateKey(db, s.workspaceId);
    if (!privateKey) return { status: "error", code: "ssh_auth_failed", info: null };
    const info = await probeServer({
      host: s.host,
      port: s.port,
      username: s.username,
      privateKey,
      hostKeyAlgo: s.hostKeyAlgo!,
      hostKey: s.hostKey!,
      allowPrivate: env.appServersAllowPrivate,
    });
    if (info.baseDomain !== s.baseDomain) return { status: "error", code: "server_domain_mismatch", info };
    return { status: "ready", code: null, info };
  } catch (e) {
    const code = sshErrorCode(e);
    // the message can name the host and port, never a key; keep it in the log only
    log.warn({ serverId: s.id, workspaceId: s.workspaceId, code, err: (e as Error)?.message }, "server re-check failed");
    return { status: "error", code, info: e instanceof HelperOutdatedError ? e.info : null };
  }
}

/** Tell the workspace's Owners (each one, by their own preferences) that a server stopped passing its check. */
async function notifyOwners(s: Server, code: string): Promise<void> {
  const [ws] = await db.select({ locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, s.workspaceId));
  const owners = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, s.workspaceId), eq(members.role, "OWNER")));
  const locale = ws?.locale ?? null;
  const key = `server.reason.${code}`;
  const reason = msg(locale, (key in MESSAGE_CATALOG.en ? key : "server.reason.unknown") as MessageKey);
  for (const o of owners) {
    await miscQueue.add("notify", {
      kind: "notify",
      notificationKind: "incident",
      workspaceId: s.workspaceId,
      userId: o.userId,
      subject: msg(locale, "server.down", { name: s.name }),
      text: msg(locale, "server.downText", { name: s.name, host: s.host, reason }),
      link: "/settings?tab=servers",
    });
  }
}

/**
 * Re-check one server and store the result. The update only applies while the server still has the status and
 * pinned key it was probed with: an Owner re-verifying (new pin) or editing it (back to pending) in the meantime
 * wins. A ready → error transition notifies the Owners once (the conditional update decides who sends it).
 */
export async function recheckServer(s: Server, now: Date = new Date()): Promise<RecheckOutcome | null> {
  if (!s.hostKey || !s.hostKeyAlgo || (s.status !== "ready" && s.status !== "error")) return null;
  const r = await probe(s);
  const [row] = await db
    .update(servers)
    .set({ status: r.status, statusMessage: r.code, ...(r.info ? { info: r.info } : {}), lastCheckedAt: now, updatedAt: now })
    .where(and(eq(servers.id, s.id), eq(servers.status, s.status), eq(servers.hostKey, s.hostKey), eq(servers.hostKeyAlgo, s.hostKeyAlgo)))
    .returning({ id: servers.id });
  if (!row) return null;
  await publish(s.workspaceId, { type: "server.updated", serverId: s.id, status: r.status });
  const wentDown = s.status === "ready" && r.status === "error";
  if (wentDown) await notifyOwners(s, r.code ?? "unknown");
  if (s.status === "error" && r.status === "ready") log.info({ serverId: s.id, workspaceId: s.workspaceId }, "server passes its check again");
  return { serverId: s.id, status: r.status, code: r.code, wentDown };
}

/**
 * Called every SERVER_RECHECK_TICK_MS: probes each verified server (ready or error, with a pinned host key) whose
 * last check is SERVER_RECHECK_EVERY_MS old or more, oldest first.
 */
export async function recheckServers(now: Date = new Date()): Promise<RecheckOutcome[]> {
  const due = await db
    .select()
    .from(servers)
    .where(
      and(
        inArray(servers.status, ["ready", "error"]),
        isNotNull(servers.hostKey),
        isNotNull(servers.hostKeyAlgo),
        or(isNull(servers.lastCheckedAt), lte(servers.lastCheckedAt, new Date(now.getTime() - SERVER_RECHECK_EVERY_MS))),
      ),
    )
    .orderBy(sql`${servers.lastCheckedAt} asc nulls first`)
    .limit(RECHECK_BATCH);
  const out: RecheckOutcome[] = [];
  for (const s of due) {
    try {
      const r = await recheckServer(s, now);
      if (r) out.push(r);
    } catch (e) {
      log.warn({ err: e, serverId: s.id }, "server re-check could not be stored");
    }
  }
  return out;
}
