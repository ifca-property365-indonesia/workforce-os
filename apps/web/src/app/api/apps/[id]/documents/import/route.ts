import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { appDocuments, audit, db, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { body, notFound, route } from "@/lib/server/route";

/** PRDs written as task deliverables (draft_document kind prd) in this workspace, newest first: what can be imported. */
export const GET = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  await loadApp(session.workspaceId, params.id);
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, deliverables: tasks.deliverables, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, session.workspaceId), sql`${tasks.deliverables} @> '[{"kind":"prd"}]'::jsonb`))
    .orderBy(desc(tasks.createdAt))
    .limit(20);
  return {
    candidates: rows.flatMap((t) => t.deliverables.filter((d) => d.kind === "prd").map((d) => ({ taskId: t.id, taskTitle: t.title, deliverableId: d.id, title: d.title, createdAt: d.createdAt }))),
  };
});

const schema = z.object({ taskId: z.string().uuid(), deliverableId: z.string().min(1).max(100) });

/** A PRD deliverable becomes the next version of the app's PRD (a draft, approved like any other). */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const [t] = await db.select({ deliverables: tasks.deliverables }).from(tasks).where(and(eq(tasks.id, b.taskId), eq(tasks.workspaceId, session.workspaceId)));
  const d = t?.deliverables.find((x) => x.id === b.deliverableId && x.kind === "prd");
  if (!d) notFound("prd_not_found");
  if (d.content.length < 50) throw new HttpError(400, "That PRD is empty", { code: "prd_not_found" });
  const version = await db.transaction(async (tx) => {
    const [m] = await tx.select({ v: max(appDocuments.version) }).from(appDocuments).where(and(eq(appDocuments.appId, app.id), eq(appDocuments.kind, "prd"), isNull(appDocuments.moduleId)));
    const v = (m?.v ?? 0) + 1;
    await tx.insert(appDocuments).values({ workspaceId: session.workspaceId, appId: app.id, kind: "prd", version: v, title: d.title, content: d.content, note: "Imported from a task deliverable", taskId: b.taskId, createdBy: session.userId });
    return v;
  });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.document_imported", targetType: "app", targetId: app.id, details: { name: app.name, version, taskId: b.taskId } });
  return { version };
});
