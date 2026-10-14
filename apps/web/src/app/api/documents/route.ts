import { and, desc, eq, isNull } from "drizzle-orm";
import { clients, db, documents } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { clientIdParam } from "@/lib/server/clients";
import { route } from "@/lib/server/route";
import { saveDocument } from "@/lib/server/uploads";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The knowledge base, newest first. ?clientId=<id> lists one client's documents, ?clientId=general the shared ones. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const sp = req.nextUrl.searchParams;
  const general = sp.get("clientId") === "general";
  const clientId = general ? undefined : clientIdParam(sp);
  const rows = await db
    .select({
      id: documents.id,
      name: documents.name,
      mime: documents.mime,
      size: documents.size,
      status: documents.status,
      chunkCount: documents.chunkCount,
      error: documents.error,
      clientId: documents.clientId,
      clientName: clients.name,
      clientCode: clients.code,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .leftJoin(clients, and(eq(clients.id, documents.clientId), eq(clients.workspaceId, session.workspaceId)))
    .where(and(eq(documents.workspaceId, session.workspaceId), general ? isNull(documents.clientId) : clientId ? eq(documents.clientId, clientId) : undefined))
    .orderBy(desc(documents.createdAt));
  return { documents: rows };
});

/**
 * Upload up to 10 files. An optional `clientId` form field makes them that client's knowledge: searchable only on
 * work for that client.
 */
export const POST = route("MEMBER", async ({ session, req }) => {
  const form = await req.formData();
  const rawClient = form.get("clientId");
  let clientId: string | null = null;
  if (typeof rawClient === "string" && rawClient) {
    const [c] = UUID.test(rawClient)
      ? await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, rawClient), eq(clients.workspaceId, session.workspaceId)))
      : [];
    if (!c) throw new HttpError(400, "Unknown client", { code: "unknown_client" });
    clientId = c.id;
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) throw new HttpError(400, "No files", { code: "no_files" });
  const out = [];
  for (const f of files.slice(0, 10)) out.push(await saveDocument(session.workspaceId, session.userId, f, { clientId }));
  return { documents: out.map((d) => ({ id: d.id, name: d.name, status: d.status, clientId: d.clientId })) };
});
