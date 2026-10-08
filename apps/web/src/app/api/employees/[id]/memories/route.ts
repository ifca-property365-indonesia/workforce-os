import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, employees, memories } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";

type P = { id: string };

async function check(workspaceId: string, id: string) {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  if (!e) notFound("employee_not_found");
}

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  await check(session.workspaceId, params.id);
  const rows = await db
    .select({ id: memories.id, kind: memories.kind, content: memories.content, source: memories.source, createdAt: memories.createdAt })
    .from(memories)
    .where(eq(memories.employeeId, params.id))
    .orderBy(desc(memories.createdAt));
  return { memories: rows };
});

const schema = z.object({ content: z.string().min(2).max(2000), kind: z.enum(["fact", "feedback", "preference"]).default("fact") });

export const POST = route<P>("MEMBER", async ({ session, req, params }) => {
  await check(session.workspaceId, params.id);
  const input = await body(req, schema);
  // embedding is filled in by the worker's backfill loop
  const [m] = await db.insert(memories).values({ workspaceId: session.workspaceId, employeeId: params.id, ...input, source: "user" }).returning({ id: memories.id });
  return { id: m!.id };
});
