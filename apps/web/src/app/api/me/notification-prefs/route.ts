import { z } from "zod";
import { db, notificationPrefs } from "@wfos/db";
import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS, notificationDefault, type NotificationChannelPrefs } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { fullMatrix, loadPrefs } from "@/lib/server/notifications";
import { assertWorkspaceEmployees } from "@/lib/server/teams";

/** This user's notification preferences in this workspace: kinds × channels (missing = the default) and muted employees. */
export const GET = route("VIEWER", async ({ session }) => {
  const p = await loadPrefs(session.userId, session.workspaceId);
  return { kinds: NOTIFICATION_KINDS, channelNames: NOTIFICATION_CHANNELS, channels: fullMatrix(p.channels), mutedEmployeeIds: p.mutedEmployeeIds };
});

const schema = z
  .object({
    channels: z.partialRecord(z.enum(NOTIFICATION_KINDS), z.partialRecord(z.enum(NOTIFICATION_CHANNELS), z.boolean())),
    mutedEmployeeIds: z.array(z.uuid()).max(500),
  })
  .strict();

export const PUT = route("VIEWER", async ({ session, req }) => {
  const input = await body(req, schema);
  const muted = [...new Set(input.mutedEmployeeIds)];
  await assertWorkspaceEmployees(session.workspaceId, muted);
  // store only the switches that differ from notificationDefault, so new kinds and channels take their default
  const channels: NotificationChannelPrefs = {};
  for (const k of NOTIFICATION_KINDS) {
    const set = NOTIFICATION_CHANNELS.flatMap((c) => {
      const v = input.channels[k]?.[c];
      return v === undefined || v === notificationDefault(k, c) ? [] : [[c, v] as const];
    });
    if (set.length) channels[k] = Object.fromEntries(set);
  }
  await db
    .insert(notificationPrefs)
    .values({ userId: session.userId, workspaceId: session.workspaceId, channels, mutedEmployeeIds: muted })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.workspaceId], set: { channels, mutedEmployeeIds: muted, updatedAt: new Date() } });
  return { kinds: NOTIFICATION_KINDS, channelNames: NOTIFICATION_CHANNELS, channels: fullMatrix(channels), mutedEmployeeIds: muted };
});
