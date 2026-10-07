import { desc, eq } from "drizzle-orm";
import { db, documents } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { route } from "@/lib/server/route";
import { saveDocument } from "@/lib/server/uploads";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db
    .select({ id: documents.id, name: documents.name, mime: documents.mime, size: documents.size, status: documents.status, chunkCount: documents.chunkCount, error: documents.error, createdAt: documents.createdAt })
    .from(documents)
    .where(eq(documents.workspaceId, session.workspaceId))
    .orderBy(desc(documents.createdAt));
  return { documents: rows };
});

export const POST = route("MEMBER", async ({ session, req }) => {
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) throw new HttpError(400, "No files");
  const out = [];
  for (const f of files.slice(0, 10)) out.push(await saveDocument(session.workspaceId, session.userId, f));
  return { documents: out.map((d) => ({ id: d.id, name: d.name, status: d.status })) };
});
