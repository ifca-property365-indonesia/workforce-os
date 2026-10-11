import { z } from "zod";
import { db, notificationPrefs } from "@wfos/db";
import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS, type NotificationChannelPrefs } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { fullMatrix, loadPrefs } from "@/lib/server/notifications";
import { assertWorkspaceEmployees } from "@/lib/server/teams";

/** This user's notification preferences in this workspace: kinds × channels (missing = on) and muted employees. */
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
  // store only the switches that are off: anything missing means "on", so new kinds and channels default on
  const channels: NotificationChannelPrefs = {};
  for (const k of NOTIFICATION_KINDS) {
    const off = Object.fromEntries(NOTIFICATION_CHANNELS.filter((c) => input.channels[k]?.[c] === false).map((c) => [c, false]));
    if (Object.keys(off).length) channels[k] = off;
  }
  await db
    .insert(notificationPrefs)
    .values({ userId: session.userId, workspaceId: session.workspaceId, channels, mutedEmployeeIds: muted })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.workspaceId], set: { channels, mutedEmployeeIds: muted, updatedAt: new Date() } });
  return { kinds: NOTIFICATION_KINDS, channelNames: NOTIFICATION_CHANNELS, channels: fullMatrix(channels), mutedEmployeeIds: muted };
});
