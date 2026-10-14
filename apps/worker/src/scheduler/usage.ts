import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, resolveClaudeCredential, workspaces } from "@wfos/db";
import type { ClaudeCredential } from "@wfos/db/claude";
import { agentEnv, env } from "../lib/env";
import { fetchUsageWindows, recordUsageWindows } from "../lib/limits";
import { log } from "../lib/logger";
import { redis } from "../lib/redis";
import { agentQuery } from "../runner/sdk";

/**
 * Subscription usage sync: every USAGE_SYNC_EVERY_MS the plan's usage windows of each workspace's Claude subscription
 * credential are read through the Agent SDK's experimental usage call and stored (claude_limits), so the dashboard
 * does not depend on the rare rate_limit_events. A query is opened in streaming-input mode, the usage is asked, and the
 * query is closed WITHOUT sending a prompt: no model call, no tokens (verified against a stub API: the CLI makes no
 * /v1/messages request). One fetch per credential (the instance fallback serves every workspace using it); a
 * credential whose usage is unavailable (no profile scope, e.g. some setup tokens) is skipped for a while.
 */
export const USAGE_SYNC_EVERY_MS = 15 * 60_000;
/** a credential that reported no plan limits is asked again after this long */
export const USAGE_UNAVAILABLE_BACKOFF_MS = 6 * 3_600_000;
const QUERY_TIMEOUT_MS = 20_000;

const skipUntil = new Map<string, number>();
/** tests */
export function resetUsageSync(): void {
  skipUntil.clear();
}

const credentialKey = (c: ClaudeCredential) => createHash("sha256").update(c.type).update("\0").update(c.secret).digest("hex").slice(0, 24);

/** Open an idle query (no prompt is ever sent), ask it for the usage windows, close it. Never throws. */
export async function usageViaIdleQuery(workspaceId: string, credential: ClaudeCredential): Promise<Awaited<ReturnType<typeof fetchUsageWindows>>> {
  const home = path.join(env.storageDir, "agent-home", workspaceId);
  const cwd = path.join(env.storageDir, "sandbox", `usage-${randomUUID()}`);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // streaming input that never yields: the session starts, but no user message (so no model call) ever goes out
  async function* noPrompt(): AsyncGenerator<never> {
    await held;
  }
  const controller = new AbortController();
  let q: ReturnType<typeof agentQuery> | null = null;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    q = agentQuery({
      prompt: noPrompt() as never,
      options: {
        abortController: controller,
        cwd,
        env: agentEnv(home, credential),
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "default",
        maxTurns: 1,
        canUseTool: async () => ({ behavior: "deny", message: "No tools." }),
      },
    });
    return await fetchUsageWindows(q, QUERY_TIMEOUT_MS);
  } catch {
    return null;
  } finally {
    release();
    try {
      q?.close();
    } catch {
      /* closed already */
    }
    controller.abort();
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One sync pass over every workspace with a subscription (oauth) credential. Never throws; returns what it did.
 * `fetch` is swappable for tests.
 */
export async function syncSubscriptionUsage(o: { now?: number; fetch?: typeof usageViaIdleQuery } = {}): Promise<{ fetched: number; stored: number; unavailable: number }> {
  const now = o.now ?? Date.now();
  const fetch = o.fetch ?? usageViaIdleQuery;
  const out = { fetched: 0, stored: 0, unavailable: 0 };
  try {
    const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.demoMode, false));
    const groups = new Map<string, { credential: ClaudeCredential; workspaceIds: string[] }>();
    for (const w of rows) {
      const c = await resolveClaudeCredential(w.id).catch(() => null);
      if (!c || c.type !== "oauth") continue;
      const key = credentialKey(c);
      const g = groups.get(key) ?? { credential: c, workspaceIds: [] };
      g.workspaceIds.push(w.id);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      if ((skipUntil.get(key) ?? 0) > now) continue;
      // once per credential and period, also with several worker processes
      const claimed = await redis.set(`wfos:usage-sync:${key}`, "1", "PX", USAGE_SYNC_EVERY_MS - 60_000, "NX").catch(() => "OK");
      if (!claimed) continue;
      const windows = await fetch(g.workspaceIds[0]!, g.credential);
      out.fetched++;
      if (windows === null) continue; // failed or timed out: next period
      if (!windows.length) {
        out.unavailable++;
        skipUntil.set(key, now + USAGE_UNAVAILABLE_BACKOFF_MS);
        log.info({ workspaces: g.workspaceIds.length }, "subscription usage unavailable for this credential (no plan limits reported); retried later");
        continue;
      }
      for (const id of g.workspaceIds) {
        // rows are per workspace and credential source (the instance fallback is shared)
        const stored = await recordUsageWindows(id, g.credential.source, windows).catch((e: unknown) => (log.warn({ err: e, workspaceId: id }, "usage not stored"), 0));
        if (stored) out.stored++;
      }
    }
  } catch (e) {
    log.warn({ err: e }, "subscription usage sync failed");
  }
  return out;
}
