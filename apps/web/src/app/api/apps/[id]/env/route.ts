import { eq } from "drizzle-orm";
import { z } from "zod";
import { appEnvironments, audit, db } from "@wfos/db";
import { APP_ENV_NAME_RE, appEnvSchema } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { HttpError } from "@/lib/server/auth";
import { loadAppEnv, readEnv, requireLiveOwner } from "@/lib/server/apps";
import { publish } from "@/lib/server/queue";
import { route } from "@/lib/server/route";

/**
 * A merge, so a person never has to re-enter the values they do not change (values are never shown again):
 * `set` adds or overwrites names, `remove` drops names. The whole env is validated after the merge.
 */
const mergeSchema = z
  .object({
    set: z.record(z.string(), z.string()).default({}),
    remove: z.array(z.string().regex(APP_ENV_NAME_RE)).max(100).default([]),
  })
  .strict();

/**
 * Replace (a plain `{ NAME: value }` object) or merge (`{ set, remove }`) the extra env of one environment
 * (`?env=preview`, the default, or `?env=live`: the two never share values). The values are stored encrypted and
 * reach only the server's root-owned env file at that environment's next deploy; the response and every other
 * endpoint return the names only. The live environment's values are the Owner's, with a fresh step-up.
 */
export const PUT = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env: e } = await loadAppEnv(session.workspaceId, params.id, req);
  if (e.kind === "live") await requireLiveOwner(session);
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body", { code: "invalid_json" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new HttpError(400, "Body must be an object", { code: "invalid_json" });
  const before = readEnv(e.envEnc);
  let next: Record<string, string>;
  // env names are UPPER_CASE, so lower-case `set` / `remove` can only mean a merge
  if ("set" in json || "remove" in json) {
    const m = mergeSchema.parse(json);
    next = { ...before };
    for (const k of m.remove) delete next[k];
    Object.assign(next, appEnvSchema.parse(m.set));
  } else next = { ...(json as Record<string, string>) };
  const env = appEnvSchema.parse(next);
  const keys = Object.keys(env).sort();
  await db
    .update(appEnvironments)
    .set({ envEnc: keys.length ? encryptSecret(JSON.stringify(env)) : null, updatedAt: new Date() })
    .where(eq(appEnvironments.id, e.id));
  const old = Object.keys(before);
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.env_updated",
    targetType: "app",
    targetId: a.id,
    // names only: never a value, not even a hash of one
    details: {
      name: a.name,
      environment: e.kind,
      environmentId: e.id,
      added: keys.filter((k) => !old.includes(k)),
      changed: keys.filter((k) => old.includes(k) && before[k] !== env[k]),
      removed: old.filter((k) => !keys.includes(k)),
    },
  });
  await publish(session.workspaceId, { type: "app.updated", appId: a.id, status: e.status, environmentId: e.id });
  return { envKeys: keys };
});
