import { and, desc, eq, isNull } from "drizzle-orm";
import { db, notifications } from "@wfos/db";
import { route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(notifications).where(eq(notifications.workspaceId, session.workspaceId)).orderBy(desc(notifications.createdAt)).limit(30);
  return { notifications: rows, unread: rows.filter((r) => !r.readAt).length };
});

export const POST = route("VIEWER", async ({ session }) => {
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.workspaceId, session.workspaceId), isNull(notifications.readAt)));
  return { ok: true };
});
