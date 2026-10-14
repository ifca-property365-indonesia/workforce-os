import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { clients, db, employees, memories } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";
import { journal, memorySnapshot, memoryState } from "@/lib/server/memory-journal";

type P = { id: string };

async function check(workspaceId: string, id: string) {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  if (!e) notFound("employee_not_found");
}

/** Every memory, with its state: expired and superseded ones are kept (the UI shows them on request) but not recalled. */
export const GET = route<P>("VIEWER", async ({ session, params }) => {
  await check(session.workspaceId, params.id);
  const rows = await db
    .select({
      id: memories.id,
      kind: memories.kind,
      content: memories.content,
      source: memories.source,
      untrusted: memories.untrusted,
      // learned on a client's task: recalled only on that client's work
      clientId: memories.clientId,
      clientName: clients.name,
      clientCode: clients.code,
      expiresAt: memories.expiresAt,
      supersededBy: memories.supersededBy,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .leftJoin(clients, and(eq(clients.id, memories.clientId), eq(clients.workspaceId, session.workspaceId)))
    .where(and(eq(memories.employeeId, params.id), eq(memories.workspaceId, session.workspaceId)))
    .orderBy(desc(memories.createdAt));
  const now = Date.now();
  return { memories: rows.map((m) => ({ ...m, state: memoryState(m, now) })) };
});

const schema = z.object({
  content: z.string().min(2).max(2000),
  kind: z.enum(["fact", "feedback", "preference"]).default("fact"),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const POST = route<P>("MEMBER", async ({ session, req, params }) => {
  await check(session.workspaceId, params.id);
  const { expiresAt, ...input } = await body(req, schema);
  // embedding is filled in by the worker's backfill loop
  const m = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memories)
      .values({ workspaceId: session.workspaceId, employeeId: params.id, ...input, expiresAt: expiresAt ? new Date(expiresAt) : null, source: "user" })
      .returning();
    await journal(tx, { workspaceId: session.workspaceId, employeeId: params.id, memoryId: row!.id, action: "create", actorUserId: session.userId, before: null, after: memorySnapshot(row!) });
    return row!;
  });
  return { id: m.id };
});
