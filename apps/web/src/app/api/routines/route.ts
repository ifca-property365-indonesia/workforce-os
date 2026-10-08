import { desc, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { audit, db, nextCronRun, routines } from "@wfos/db";
import { routineInputSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

function validateCron(cron: string, tz: string) {
  try {
    CronExpressionParser.parse(cron, { tz });
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`, { code: "invalid_cron", detail: (e as Error).message });
  }
}

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(routines).where(eq(routines.workspaceId, session.workspaceId)).orderBy(desc(routines.createdAt));
  return { routines: rows };
});

export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, routineInputSchema);
  if (!input.assigneeId && !input.teamId) throw new HttpError(400, "Assign the routine to an employee or a team", { code: "routine_needs_assignee" });
  validateCron(input.cron, input.timezone);
  const [r] = await db
    .insert(routines)
    .values({ ...input, assigneeId: input.assigneeId ?? null, teamId: input.teamId ?? null, workspaceId: session.workspaceId, nextRunAt: input.enabled ? nextCronRun(input.cron, input.timezone) : null })
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "routine.created", targetType: "routine", targetId: r!.id, details: { cron: r!.cron, name: r!.name } });
  return { routine: r };
});
