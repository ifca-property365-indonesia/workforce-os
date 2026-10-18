import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, db, incidents } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";
import { PERSON_INCIDENT_STATUSES } from "@/lib/server/inbox";

const schema = z.object({ action: z.literal("resolve"), note: z.string().trim().max(500).optional() });

/**
 * A person closes an incident that was waiting for them ("Needs a decision"): it was handled outside the platform,
 * or is not worth acting on. A lead's incident (handling) is not closed from here.
 */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const { note } = await body(req, schema);
  const resolution = note ? `Closed by ${session.email}: ${note}` : `Closed by ${session.email}`;
  const [row] = await db
    .update(incidents)
    .set({ status: "resolved", resolution, resolvedAt: new Date() })
    .where(and(eq(incidents.id, params.id), eq(incidents.workspaceId, session.workspaceId), inArray(incidents.status, PERSON_INCIDENT_STATUSES)))
    .returning({ id: incidents.id, taskId: incidents.taskId, kind: incidents.kind });
  if (!row) notFound("incident_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "incident.resolved", targetType: "incident", targetId: row.id, details: { kind: row.kind, taskId: row.taskId, note: note ?? null } });
  return { ok: true };
});
