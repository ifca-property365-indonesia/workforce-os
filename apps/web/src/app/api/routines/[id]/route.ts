import { and, desc, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { audit, db, nextCronRun, routineRuns, routines } from "@wfos/db";
import { routineInputSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { notFound, patchBody, route } from "@/lib/server/route";

type P = { id: string };

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const [r] = await db.select().from(routines).where(and(eq(routines.id, params.id), eq(routines.workspaceId, session.workspaceId)));
  if (!r) notFound();
  const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)).orderBy(desc(routineRuns.startedAt)).limit(30);
  const upcoming: string[] = [];
  try {
    const it = CronExpressionParser.parse(r.cron, { tz: r.timezone });
    for (let i = 0; i < 5; i++) upcoming.push(it.next().toDate().toISOString());
  } catch {
    /* invalid cron */
  }
  return { routine: r, runs, upcoming };
});

export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const input = await patchBody(req, routineInputSchema.partial());
  const [cur] = await db.select().from(routines).where(and(eq(routines.id, params.id), eq(routines.workspaceId, session.workspaceId)));
  if (!cur) notFound();
  const cron = input.cron ?? cur.cron;
  const tz = input.timezone ?? cur.timezone;
  try {
    CronExpressionParser.parse(cron, { tz });
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`, { code: "invalid_cron", detail: (e as Error).message });
  }
  const enabled = input.enabled ?? cur.enabled;
  const [r] = await db
    .update(routines)
    .set({ ...input, nextRunAt: enabled ? nextCronRun(cron, tz) : null })
    .where(eq(routines.id, cur.id))
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "routine.updated", targetType: "routine", targetId: cur.id, details: input });
  return { routine: r };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await db.delete(routines).where(and(eq(routines.id, params.id), eq(routines.workspaceId, session.workspaceId)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "routine.deleted", targetType: "routine", targetId: params.id });
  return { ok: true };
});
