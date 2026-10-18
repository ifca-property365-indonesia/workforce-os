import { and, count, desc, eq, gt } from "drizzle-orm";
import { appDocuments, appEnvironments, appReleases, APP_DOCUMENT_KINDS, db, employees, type AppDocumentKind } from "@wfos/db";
import { loadApp } from "@/lib/server/apps";
import { route } from "@/lib/server/route";

/** C9: the app's documents per kind: every version (no content), the approved one, and preview releases since it. */
export const GET = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const rows = await db
    .select({
      id: appDocuments.id,
      kind: appDocuments.kind,
      version: appDocuments.version,
      title: appDocuments.title,
      status: appDocuments.status,
      note: appDocuments.note,
      basedOnVersion: appDocuments.basedOnVersion,
      taskId: appDocuments.taskId,
      author: employees.name,
      createdAt: appDocuments.createdAt,
      decidedAt: appDocuments.decidedAt,
    })
    .from(appDocuments)
    .leftJoin(employees, eq(employees.id, appDocuments.authorEmployeeId))
    .where(and(eq(appDocuments.appId, app.id), eq(appDocuments.workspaceId, session.workspaceId)))
    .orderBy(desc(appDocuments.version));
  const [preview] = await db.select({ id: appEnvironments.id }).from(appEnvironments).where(and(eq(appEnvironments.appId, app.id), eq(appEnvironments.kind, "preview")));
  const kinds = {} as Record<AppDocumentKind, { versions: typeof rows; approved: { id: string; version: number } | null; releasesSinceApproved: number }>;
  for (const kind of APP_DOCUMENT_KINDS) {
    const versions = rows.filter((r) => r.kind === kind);
    const approved = versions.find((v) => v.status === "approved") ?? null;
    let since = 0;
    if (approved?.decidedAt && preview) {
      const [c] = await db
        .select({ n: count() })
        .from(appReleases)
        .where(and(eq(appReleases.environmentId, preview.id), eq(appReleases.status, "deployed"), gt(appReleases.createdAt, approved.decidedAt)));
      since = Number(c?.n ?? 0);
    }
    kinds[kind] = { versions, approved: approved ? { id: approved.id, version: approved.version } : null, releasesSinceApproved: since };
  }
  return { kinds };
});
