import { and, eq, isNull } from "drizzle-orm";
import { apps, audit, db } from "@wfos/db";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { generatePreviewPassword, loadApp, PREVIEW_USER } from "@/lib/server/apps";
import { q } from "@/lib/server/queue";
import { rateLimit } from "@/lib/server/ratelimit";
import { route } from "@/lib/server/route";

/** The preview's basic-auth login (made on first view if the app has none yet). Every view is audited. */
export const GET = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  await rateLimit(`app-access:${session.userId}`, 60, 300);
  let enc = a.accessPasswordEnc;
  if (!enc) {
    // a concurrent first view (or the worker's first publish) may have set one: keep whichever was stored first
    const [row] = await db
      .update(apps)
      .set({ accessPasswordEnc: encryptSecret(generatePreviewPassword()), updatedAt: new Date() })
      .where(and(eq(apps.id, a.id), isNull(apps.accessPasswordEnc)))
      .returning({ enc: apps.accessPasswordEnc });
    enc = row?.enc ?? (await db.select({ enc: apps.accessPasswordEnc }).from(apps).where(eq(apps.id, a.id)))[0]?.enc ?? null;
  }
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.access_viewed",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, accessMode: a.accessMode },
  });
  return { username: PREVIEW_USER, password: decryptSecret(enc!) };
});

/** A new preview password. A running app is published again right away, so the old password stops working. */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  const a = await loadApp(session.workspaceId, params.id);
  await rateLimit(`app-access:${session.userId}`, 60, 300);
  const password = generatePreviewPassword();
  await db
    .update(apps)
    .set({ accessPasswordEnc: encryptSecret(password), updatedAt: new Date() })
    .where(eq(apps.id, a.id));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "app.access_rotated",
    targetType: "app",
    targetId: a.id,
    details: { name: a.name, accessMode: a.accessMode },
  });
  const republished = a.status === "running" && a.accessMode === "password";
  if (republished) await q.deploy({ kind: "app_action", appId: a.id, workspaceId: session.workspaceId, action: "republish", userId: session.userId });
  return { username: PREVIEW_USER, password, republished };
});
