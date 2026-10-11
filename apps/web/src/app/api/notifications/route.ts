import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, members, notificationReads, notifications } from "@wfos/db";
import { route } from "@/lib/server/route";
import { loadPrefs, visibleTo } from "@/lib/server/notifications";

/** Unread is counted (and "mark all read" reaches) this far back at most. */
const UNREAD_WINDOW_MS = 90 * 86400_000;

/**
 * Read state for this user: their own read row, or — for notifications from before per-user reads existed —
 * the legacy `notifications.read_at`, which counts for every member. Only notifications from the unread window
 * (created after the member joined the workspace, and within 90 days) can be unread: older ones, and broadcasts
 * from before someone joined, are shown as read, so the bell never highlights rows "mark all read" cannot clear.
 */
async function readState(session: { userId: string; workspaceId: string }) {
  const [m] = await db
    .select({ joinedAt: members.createdAt })
    .from(members)
    .where(and(eq(members.workspaceId, session.workspaceId), eq(members.userId, session.userId)));
  const since90 = new Date(Date.now() - UNREAD_WINDOW_MS);
  const from = m && m.joinedAt > since90 ? m.joinedAt : since90;
  const mine = and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, session.userId));
  const read = or(isNotNull(notificationReads.notificationId), isNotNull(notifications.readAt))!;
  const unread = and(isNull(notificationReads.notificationId), isNull(notifications.readAt), gte(notifications.createdAt, from))!;
  return { mine, read, unread, from };
}

/** The bell: notifications this user sees (broadcasts + addressed to them, minus muted), with their own read state. */
export const GET = route("VIEWER", async ({ session }) => {
  const prefs = await loadPrefs(session.userId, session.workspaceId);
  const visible = visibleTo(session.userId, session.workspaceId, prefs);
  const { mine, read, unread, from } = await readState(session);
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      employeeId: notifications.employeeId,
      createdAt: notifications.createdAt,
      read: sql<boolean>`(${read})`,
    })
    .from(notifications)
    .leftJoin(notificationReads, mine)
    .where(visible)
    .orderBy(desc(notifications.createdAt))
    .limit(30);
  const [{ unread: count } = { unread: 0 }] = await db
    .select({ unread: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(notificationReads, mine)
    .where(and(visible, unread));
  return { notifications: rows.map((r) => ({ ...r, read: !!r.read || r.createdAt < from })), unread: count };
});

/** Mark everything this user sees as read (for this user only): one read row per notification still unread for them. */
export const POST = route("VIEWER", async ({ session }) => {
  const prefs = await loadPrefs(session.userId, session.workspaceId);
  const { mine, unread } = await readState(session);
  await db
    .insert(notificationReads)
    .select(
      db
        .select({ notificationId: notifications.id, userId: sql<string>`${session.userId}::uuid`.as("user_id"), readAt: sql<Date>`now()`.as("read_at") })
        .from(notifications)
        .leftJoin(notificationReads, mine)
        .where(and(visibleTo(session.userId, session.workspaceId, prefs), unread)),
    )
    .onConflictDoNothing();
  return { ok: true };
});
