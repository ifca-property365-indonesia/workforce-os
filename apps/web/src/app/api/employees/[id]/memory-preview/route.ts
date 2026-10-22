import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { clients, db, employees } from "@wfos/db";
import { memoryPreviewKey, type MemoryPreviewItem } from "@wfos/shared";
import { serverEnv } from "@/lib/server/env";
import { q, redis } from "@/lib/server/queue";
import { body, notFound, route } from "@/lib/server/route";

type P = { id: string };

const schema = z.object({ brief: z.string().trim().min(2).max(4000), clientId: z.uuid().nullish() });

/**
 * Memory preview (after OpenHuman's pack preview): which memories the employee would get for this brief. The worker
 * holds the embedding model, so this asks it (a misc job) and the result is fetched with GET ?request=.
 */
export const POST = route<P>("MEMBER", async ({ session, req, params }) => {
  const input = await body(req, schema);
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound("employee_not_found");
  if (input.clientId) {
    const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, input.clientId), eq(clients.workspaceId, session.workspaceId)));
    if (!c) notFound();
  }
  const requestId = randomUUID();
  await q.misc({ kind: "memory_preview", workspaceId: session.workspaceId, employeeId: e.id, brief: input.brief, clientId: input.clientId ?? null, requestId });
  return { requestId };
});

/** The preview once the worker left it (ready false until then; it is kept for two minutes). */
export const GET = route<P>("MEMBER", async ({ req }) => {
  const requestId = req.nextUrl.searchParams.get("request") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return { ready: false, memories: [] };
  const raw = await redis().get(memoryPreviewKey(serverEnv.namespace, requestId));
  return raw ? { ready: true, memories: JSON.parse(raw) as MemoryPreviewItem[] } : { ready: false, memories: [] };
});
