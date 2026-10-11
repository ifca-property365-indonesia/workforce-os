import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, workspaces } from "@wfos/db";
import { body, route } from "@/lib/server/route";
import { previewCron } from "@/lib/server/cron-preview";
import { serverT } from "@/lib/server/i18n";
import { rateLimit } from "@/lib/server/ratelimit";

/** Preview calls per user per minute (the form asks on every pause in typing). */
const PREVIEW_PER_MIN = 60;

const schema = z.object({ cron: z.string().trim().min(1).max(120), timezone: z.string().trim().min(1).max(64) });

/**
 * Live preview for the routine form and routine approvals: is the rule valid, what it means in words
 * (in the user's language), and its next three firings. `displayTimezone` is the workspace's zone for showing them.
 * Pure computation, so viewers may use it too (a routine approval card shows the schedule to everyone); rate
 * limited per user.
 */
export const POST = route("VIEWER", async ({ session, req }) => {
  await rateLimit(`routine-preview:${session.userId}`, PREVIEW_PER_MIN, 60);
  const input = await body(req, schema);
  const { t, locale } = await serverT();
  const [ws] = await db.select({ timezone: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const p = previewCron(input.cron, input.timezone, locale);
  const displayTimezone = ws?.timezone ?? input.timezone;
  if (!p.valid) {
    const error =
      p.error === "invalid_timezone"
        ? t("routines.preview.invalidTimezone", { timezone: p.detail })
        : p.error === "cron_fields"
          ? t("routines.preview.fiveFields", { count: Number(p.detail) })
          : t("routines.preview.invalidCron", { detail: p.detail });
    return { valid: false, error, code: p.error, label: null, nextRuns: [], displayTimezone };
  }
  return { valid: true, label: p.label, nextRuns: p.nextRuns, displayTimezone };
});
