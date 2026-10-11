import { audit } from "@wfos/db";
import { route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { commitImport, readPackage } from "@/lib/server/packages";

/** Import a package (additive, one transaction). Needs a fresh password + 2FA confirmation. */
export const POST = route("ADMIN", async ({ session, req }) => {
  await requireStepUp(session);
  const pkg = await readPackage(req);
  const created = await commitImport(session.workspaceId, pkg);
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "package.imported",
    targetType: "package",
    targetId: null,
    details: {
      name: pkg.meta.name,
      counts: {
        employees: created.employees.length,
        teams: created.teams.length,
        routines: created.routines.length,
        departments: created.departments.length,
        mcpSlots: created.mcpSlots.length,
        memories: created.memories,
      },
      mcpSlots: created.mcpSlots.map((s) => ({ name: s.name, from: s.from })),
      employeeIds: created.employees.map((e) => e.id),
    },
  });
  return { created };
});
