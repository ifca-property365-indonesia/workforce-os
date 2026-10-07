import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, db, employees, teams } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db.select().from(conversations).where(eq(conversations.workspaceId, session.workspaceId)).orderBy(desc(conversations.updatedAt)).limit(100);
  return { conversations: rows };
});

const schema = z.object({ employeeId: z.string().uuid().optional(), teamId: z.string().uuid().optional(), title: z.string().max(120).optional() });

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, schema);
  if (!input.employeeId && !input.teamId) throw new HttpError(400, "Pick an employee or a team");
  if (input.employeeId) {
    const [e] = await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, input.employeeId), eq(employees.workspaceId, session.workspaceId)));
    if (!e) throw new HttpError(400, "Unknown employee");
  }
  if (input.teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, session.workspaceId)));
    if (!t) throw new HttpError(400, "Unknown team");
  }
  const [c] = await db
    .insert(conversations)
    .values({ workspaceId: session.workspaceId, employeeId: input.employeeId ?? null, teamId: input.teamId ?? null, title: input.title ?? "New chat", createdBy: session.userId })
    .returning();
  return { conversation: c };
});
