import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { appDocuments, audit, db } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { loadApp } from "@/lib/server/apps";
import { body, notFound, route } from "@/lib/server/route";

async function loadDoc(workspaceId: string, appId: string, docId: string) {
  const [d] = await db.select().from(appDocuments).where(and(eq(appDocuments.id, docId), eq(appDocuments.appId, appId), eq(appDocuments.workspaceId, workspaceId)));
  if (!d) notFound("app_document_not_found");
  return d;
}

/** One version with its content, and the approved version of the same kind (to compare). */
export const GET = route<{ id: string; docId: string }>("MEMBER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const doc = await loadDoc(session.workspaceId, app.id, params.docId);
  const [approved] = await db
    .select({ id: appDocuments.id, version: appDocuments.version, content: appDocuments.content })
    .from(appDocuments)
    .where(and(eq(appDocuments.appId, app.id), eq(appDocuments.kind, doc.kind), eq(appDocuments.status, "approved"), ne(appDocuments.id, doc.id)));
  return { doc, approved: approved ?? null };
});

const schema = z.object({ action: z.enum(["approve", "reject"]) });

/**
 * Approve a draft (the previous approved version of that kind becomes superseded) or reject it. Admins; audited.
 * Approving an app document starts nothing: it is the reference people and employees work from.
 */
export const POST = route<{ id: string; docId: string }>("ADMIN", async ({ session, req, params }) => {
  const { action } = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const doc = await loadDoc(session.workspaceId, app.id, params.docId);
  if (doc.status !== "draft") throw new HttpError(409, "Only a draft can be approved or rejected", { code: "app_document_not_draft" });
  const now = new Date();
  await db.transaction(async (tx) => {
    if (action === "approve") {
      await tx.update(appDocuments).set({ status: "superseded" }).where(and(eq(appDocuments.appId, app.id), eq(appDocuments.kind, doc.kind), eq(appDocuments.status, "approved")));
    }
    await tx.update(appDocuments).set({ status: action === "approve" ? "approved" : "rejected", decidedBy: session.userId, decidedAt: now }).where(eq(appDocuments.id, doc.id));
  });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: action === "approve" ? "app.document_approved" : "app.document_rejected",
    targetType: "app",
    targetId: app.id,
    details: { name: app.name, kind: doc.kind, version: doc.version },
  });
  return { ok: true };
});
