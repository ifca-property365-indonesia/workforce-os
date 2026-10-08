import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employees, replays } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";

type P = { id: string };

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const [r] = await db.select().from(replays).where(and(eq(replays.id, params.id), eq(replays.workspaceId, session.workspaceId)));
  return { replay: r ?? notFound() };
});

const schema = z.object({ action: z.enum(["promote", "discard"]) });

/** Promote = apply the proposed instructions to the employee (only after reviewing the diff). */
export const POST = route<P>("ADMIN", async ({ session, req, params }) => {
  const { action } = await body(req, schema);
  const [r] = await db.select().from(replays).where(and(eq(replays.id, params.id), eq(replays.workspaceId, session.workspaceId)));
  if (!r) notFound();
  if (action === "discard") {
    await db.update(replays).set({ status: "discarded" }).where(eq(replays.id, r.id));
    return { ok: true };
  }
  if (r.status !== "done") throw new HttpError(409, "Replay must finish before promoting", { code: "replay_not_finished" });
  const [e] = await db.select().from(employees).where(eq(employees.id, r.employeeId));
  await db
    .update(employees)
    .set({ ...r.proposed, instructionsVersion: (e?.instructionsVersion ?? 1) + 1 })
    .where(eq(employees.id, r.employeeId));
  await db.update(replays).set({ status: "promoted" }).where(eq(replays.id, r.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "employee.instructions_promoted", targetType: "employee", targetId: r.employeeId, details: { replayId: r.id } });
  return { ok: true };
});
