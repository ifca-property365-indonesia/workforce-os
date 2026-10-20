import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, changedFields, db, employeeRevisions, employees, employeeSkills, skills, snapshotEmployee, withEmployeeRevision } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

const schema = z.object({ action: z.literal("restore") });

/**
 * P2: restore an employee's configuration to one of its revisions (a new revision, source "rollback"). The same rules
 * as an edit: Workspace mode or wider network access need a fresh step-up, the allow-list is the Owner's. Skills that
 * no longer exist are left out (reported).
 */
export const POST = route<{ id: string; version: string }>("ADMIN", async ({ session, req, params }) => {
  await body(req, schema);
  const version = Number(params.version);
  if (!Number.isInteger(version) || version < 1) notFound("revision_not_found");
  const [before] = await db.select().from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!before) notFound("employee_not_found");
  const [rev] = await db.select().from(employeeRevisions).where(and(eq(employeeRevisions.employeeId, before.id), eq(employeeRevisions.version, version)));
  if (!rev) notFound("revision_not_found");
  const { skillIds, ...fields } = rev.config;
  if (fields.executionMode === "workspace" && before.executionMode !== "workspace") await requireStepUp(session);
  else if (fields.egressDomains.some((d) => !before.egressDomains.includes(d))) await requireStepUp(session);
  if (JSON.stringify(fields.allowList) !== JSON.stringify(before.allowList) && !hasRole(session.role, "OWNER"))
    throw new HttpError(403, "Only an Owner can change the irreversible-action allow-list", { code: "owner_only_allow_list" });
  const textChanged = fields.instructions !== before.instructions || fields.persona !== before.persona || fields.businessContext !== before.businessContext;
  const keep = skillIds.length ? await db.select({ id: skills.id }).from(skills).where(and(eq(skills.workspaceId, session.workspaceId), inArray(skills.id, skillIds))) : [];
  const now = await snapshotEmployee(db, before.id);
  await withEmployeeRevision(db, before.id, { workspaceId: session.workspaceId, source: "rollback", actorUserId: session.userId, actorLabel: session.email, restoredVersion: version }, async (tx) => {
    await tx
      .update(employees)
      .set({ ...fields, ...(textChanged ? { instructionsVersion: before.instructionsVersion + 1 } : {}) })
      .where(eq(employees.id, before.id));
    await tx.delete(employeeSkills).where(eq(employeeSkills.employeeId, before.id));
    if (keep.length) await tx.insert(employeeSkills).values(keep.map((s) => ({ employeeId: before.id, skillId: s.id })));
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "employee.revision_restored",
    targetType: "employee",
    targetId: before.id,
    details: { version, changed: now ? changedFields(now, rev.config) : [], missingSkills: skillIds.length - keep.length },
  });
  return { ok: true, missingSkills: skillIds.length - keep.length };
});
