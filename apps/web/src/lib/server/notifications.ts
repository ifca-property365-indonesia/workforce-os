import "server-only";
import { and, eq, inArray, isNull, not, or, type SQL } from "drizzle-orm";
import { db, notificationPrefs, notifications } from "@wfos/db";
import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS, type NotificationChannelPrefs } from "@wfos/shared";

export interface Prefs {
  channels: NotificationChannelPrefs;
  mutedEmployeeIds: string[];
}

export async function loadPrefs(userId: string, workspaceId: string): Promise<Prefs> {
  const [row] = await db
    .select({ channels: notificationPrefs.channels, mutedEmployeeIds: notificationPrefs.mutedEmployeeIds })
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.workspaceId, workspaceId)));
  return { channels: row?.channels ?? {}, mutedEmployeeIds: row?.mutedEmployeeIds ?? [] };
}

/** Every kind × channel filled in (missing = on), for the preferences grid. */
export function fullMatrix(channels: NotificationChannelPrefs) {
  return Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, Object.fromEntries(NOTIFICATION_CHANNELS.map((c) => [c, channels[k]?.[c] !== false]))])) as Required<{
    [K in keyof NotificationChannelPrefs]-?: Record<(typeof NOTIFICATION_CHANNELS)[number], boolean>;
  }>;
}

/**
 * Notifications this user sees in the app: the workspace's broadcasts (userId null) and the ones addressed to them,
 * minus kinds they switched off for in-app and employees they muted.
 */
export function visibleTo(userId: string, workspaceId: string, prefs: Prefs): SQL {
  const mutedKinds = NOTIFICATION_KINDS.filter((k) => prefs.channels[k]?.inapp === false);
  const conds: (SQL | undefined)[] = [eq(notifications.workspaceId, workspaceId), or(isNull(notifications.userId), eq(notifications.userId, userId))];
  if (mutedKinds.length) conds.push(not(inArray(notifications.kind, mutedKinds)));
  if (prefs.mutedEmployeeIds.length) conds.push(or(isNull(notifications.employeeId), not(inArray(notifications.employeeId, prefs.mutedEmployeeIds))));
  return and(...conds)!;
}
