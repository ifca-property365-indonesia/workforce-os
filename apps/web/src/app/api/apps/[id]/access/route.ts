import { and, eq, isNull } from "drizzle-orm";
import { appEnvironments, audit, db } from "@wfos/db";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { generatePreviewPassword, loadAppEnv, PREVIEW_USER, requireLiveOwner, requireOwner } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { rateLimit } from "@/lib/server/ratelimit";
import { route } from "@/lib/server/route";

/**
 * The basic-auth login of an environment (`?env=preview`, the default, or `?env=live`), made on first view if it has
 * none yet. Each environment has its own password; the live one only the Owner sees. Every view is audited.
 */
export const GET = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") requireOwner(session);
  await rateLimit(`app-access:${session.userId}`, 60, 300);
  let enc = env.accessPasswordEnc;
  if (!enc) {
    // a concurrent first view (or the worker's first publish) may have set one: keep whichever was stored first
    const [row] = await db
      .update(appEnvironments)
      .set({ accessPasswordEnc: encryptSecret(generatePreviewPassword()), updatedAt: new Date() })
      .where(and(eq(appEnvironments.id, env.id), isNull(appEnvironments.accessPasswordEnc)))
      .returning({ enc: appEnvironments.accessPasswordEnc });
    enc = row?.enc ?? (await db.select({ enc: appEnvironments.accessPasswordEnc }).from(appEnvironments).where(eq(appEnvironments.id, env.id)))[0]?.enc ?? null;
  }
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.access_viewed",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environment: env.kind, environmentId: env.id, accessMode: env.accessMode },
  });
  return { username: PREVIEW_USER, password: decryptSecret(enc!) };
});

/**
 * A new password for that environment (live: the Owner, with a fresh step-up). A running one behind a password is
 * published again right away.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") await requireLiveOwner(session);
  await rateLimit(`app-access:${session.userId}`, 60, 300);
  const password = generatePreviewPassword();
  await db
    .update(appEnvironments)
    .set({ accessPasswordEnc: encryptSecret(password), updatedAt: new Date() })
    .where(eq(appEnvironments.id, env.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.access_rotated",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, environment: env.kind, environmentId: env.id, accessMode: env.accessMode },
  });
  const republished = env.status === "running" && env.accessMode === "password";
  if (republished) {
    await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, action: "republish", userId: session.userId });
  }
  return { username: PREVIEW_USER, password, republished };
});
