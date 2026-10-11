import { audit } from "@wfos/db";
import { body, route } from "@/lib/server/route";
import { buildExport, exportRequestSchema } from "@/lib/server/packages";

/** Export employees / teams as a secret-free package; dryRun returns only the report. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, exportRequestSchema);
  const { pkg, report } = await buildExport(session.workspaceId, input);
  if (input.dryRun) return { dryRun: true, report, counts: report.counts };
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "package.exported",
    targetType: "package",
    targetId: null,
    details: { name: pkg.meta.name, counts: report.counts, rules: [...new Set(report.redactions.map((r) => r.rule))] },
  });
  return { package: pkg, report, counts: report.counts };
});
