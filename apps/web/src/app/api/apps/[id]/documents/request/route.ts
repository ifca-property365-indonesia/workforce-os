import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appDocumentTasks, APP_DOCUMENT_KINDS, audit, db, employees } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";
import { createTaskOr400 } from "@/lib/server/tasks";

const KIND_TITLE: Record<(typeof APP_DOCUMENT_KINDS)[number], string> = { prd: "Sinkronkan PRD", flow: "Dokumen alur bisnis", test_guide: "Panduan uji", deck: "Presentasi produk" };
const schema = z.object({ kind: z.enum(APP_DOCUMENT_KINDS), employeeId: z.string().uuid(), note: z.string().trim().max(2000).default("") });

/**
 * Ask an employee to write (a new version of) one of the app's documents: a task whose run may save exactly that
 * document of exactly this app (save_app_document). A person's request: documents are never rewritten on their own.
 */
export const POST = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const [emp] = await db.select().from(employees).where(and(eq(employees.id, b.employeeId), eq(employees.workspaceId, session.workspaceId)));
  if (!emp || emp.status === "ARCHIVED") throw new HttpError(400, "Choose an employee of this workspace", { code: "writer_not_found" });
  const task = await createTaskOr400(db, {
    workspaceId: session.workspaceId,
    title: `${KIND_TITLE[b.kind]}: ${app.name}`.slice(0, 200),
    brief: [`Write the ${b.kind === "test_guide" ? "test guide" : b.kind === "flow" ? "business flow" : b.kind === "deck" ? "presentation" : "PRD"} of ${app.name} and save it with save_app_document.`, b.note]
      .filter(Boolean)
      .join("\n\n"),
    assigneeId: emp.id,
    clientId: app.clientId,
    projectId: app.projectId,
    source: "board",
    createdBy: session.userId,
  });
  await db.insert(appDocumentTasks).values({ taskId: task.id, workspaceId: session.workspaceId, appId: app.id, kind: b.kind });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.document_requested", targetType: "app", targetId: app.id, details: { name: app.name, kind: b.kind, taskId: task.id, writer: emp.name } });
  await publish(session.workspaceId, { type: "task.created", taskId: task.id, title: task.title, employeeId: emp.id });
  await q.task(task.id, session.workspaceId);
  return { taskId: task.id };
});
