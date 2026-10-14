import { and, eq, gte, isNull, or, sum } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employeeDivision, employees, steps } from "@wfos/db";
import { allowListEntrySchema, employeeInputSchema, hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { notFound, patchBody, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";

type P = { id: string };

async function load(workspaceId: string, id: string) {
  const [e] = await db.select().from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  return e ?? notFound("employee_not_found");
}

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const e = await load(session.workspaceId, params.id);
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const week = new Date(Date.now() - 7 * 86_400_000);
  // the 7-day cost includes the steps this employee took as a subagent in the code lead's run, and leaves those out of
  // the code lead's: each step counts once, for coalesce(actor_employee_id, employee_id) (written so the indexes apply)
  const [[s], [w], division] = await Promise.all([
    db.select({ s: sum(steps.credits) }).from(steps).where(and(eq(steps.employeeId, e.id), eq(steps.workspaceId, session.workspaceId), gte(steps.createdAt, day))),
    db
      .select({ s: sum(steps.credits) })
      .from(steps)
      .where(
        and(
          or(eq(steps.actorEmployeeId, e.id), and(isNull(steps.actorEmployeeId), eq(steps.employeeId, e.id))),
          eq(steps.workspaceId, session.workspaceId),
          gte(steps.createdAt, week),
        ),
      ),
    employeeDivision(e.id),
  ]);
  return {
    employee: {
      ...e,
      spentToday: Number(s?.s ?? 0),
      credits7d: Number(w?.s ?? 0),
      division: division && division.division.workspaceId === session.workspaceId ? { id: division.division.id, key: division.division.key, name: division.division.name, color: division.division.color, role: division.role } : null,
    },
  };
});

const patchSchema = employeeInputSchema.partial().extend({ allowList: z.array(allowListEntrySchema).optional() });

export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const before = await load(session.workspaceId, params.id);
  const input = await patchBody(req, patchSchema);
  // Workspace mode (a sandboxed shell) and wider network access: Owner/Admin (route) + fresh password and 2FA
  const toWorkspace = input.executionMode === "workspace" && before.executionMode !== "workspace";
  const widerEgress = input.egressDomains !== undefined && input.egressDomains.some((d) => !before.egressDomains.includes(d));
  if (toWorkspace || widerEgress) await requireStepUp(session);
  if (input.allowList && !hasRole(session.role, "OWNER")) throw new HttpError(403, "Only an Owner can change the irreversible-action allow-list", { code: "owner_only_allow_list" });
  const instructionsChanged =
    (input.instructions !== undefined && input.instructions !== before.instructions) ||
    (input.persona !== undefined && input.persona !== before.persona) ||
    (input.businessContext !== undefined && input.businessContext !== before.businessContext);
  const [e] = await db
    .update(employees)
    .set({ ...input, ...(instructionsChanged ? { instructionsVersion: before.instructionsVersion + 1 } : {}) })
    .where(eq(employees.id, before.id))
    .returning();
  const permChanged =
    input.toolPermissions !== undefined ||
    input.autonomyLevel !== undefined ||
    input.allowList !== undefined ||
    input.dailyBudget !== undefined ||
    input.executionMode !== undefined ||
    input.egressDomains !== undefined;
  if (permChanged) {
    await audit({
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      actorLabel: session.email,
      action: "employee.permissions_changed",
      targetType: "employee",
      targetId: before.id,
      details: {
        before: { autonomy: before.autonomyLevel, tools: before.toolPermissions, allowList: before.allowList, dailyBudget: before.dailyBudget, executionMode: before.executionMode, egressDomains: before.egressDomains },
        after: { autonomy: e!.autonomyLevel, tools: e!.toolPermissions, allowList: e!.allowList, dailyBudget: e!.dailyBudget, executionMode: e!.executionMode, egressDomains: e!.egressDomains },
      },
    });
  }
  if (instructionsChanged) {
    await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "employee.instructions_changed", targetType: "employee", targetId: before.id, details: { version: e!.instructionsVersion } });
  }
  return { employee: e };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  const e = await load(session.workspaceId, params.id);
  await db.update(employees).set({ status: "ARCHIVED" }).where(eq(employees.id, e.id));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "employee.archived", targetType: "employee", targetId: e.id });
  return { ok: true };
});
