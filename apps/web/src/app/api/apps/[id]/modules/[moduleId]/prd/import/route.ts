import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { appDocuments, audit, db, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { loadModule } from "@/lib/server/app-modules";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ taskId: z.string().uuid(), deliverableId: z.string().min(1).max(100) });

/**
 * "Jadikan modul": a PRD written as a task deliverable (draft_document kind prd, listed by the app's documents import)
 * becomes the next version of this module's PRD, a draft an Admin approves like any other. Admins.
 */
export const POST = route<{ id: string; moduleId: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const m = await loadModule(session.workspaceId, app.id, params.moduleId);
  const [t] = await db.select({ deliverables: tasks.deliverables }).from(tasks).where(and(eq(tasks.id, b.taskId), eq(tasks.workspaceId, session.workspaceId)));
  const d = t?.deliverables.find((x) => x.id === b.deliverableId && x.kind === "prd");
  if (!d) notFound("prd_not_found");
  if (d.content.length < 50) throw new HttpError(400, "That PRD is empty", { code: "prd_not_found" });
  const version = await db.transaction(async (tx) => {
    const [v] = await tx.select({ v: max(appDocuments.version) }).from(appDocuments).where(and(eq(appDocuments.moduleId, m.id), eq(appDocuments.kind, "prd")));
    const next = (v?.v ?? 0) + 1;
    await tx.insert(appDocuments).values({
      workspaceId: session.workspaceId,
      appId: app.id,
      moduleId: m.id,
      kind: "prd",
      version: next,
      title: d.title,
      content: d.content,
      note: "Imported from a task deliverable",
      taskId: b.taskId,
      createdBy: session.userId,
    });
    return next;
  });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.module_prd_imported", targetType: "app", targetId: app.id, details: { name: app.name, module: m.name, version, taskId: b.taskId } });
  return { version };
});
