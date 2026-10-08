import { and, desc, eq, isNotNull, max } from "drizzle-orm";
import { audit, clients, db, projects, tasks, workspaces } from "@wfos/db";
import { projectHealth } from "@wfos/shared/health";
import { clientInputSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const tz = ws?.tz ?? "Asia/Jakarta";
  const cs = await db.select().from(clients).where(eq(clients.workspaceId, session.workspaceId)).orderBy(desc(clients.createdAt));
  const ps = await db.select().from(projects).where(eq(projects.workspaceId, session.workspaceId));
  // last activity per project = latest task update on it (or the project's own update)
  const activity = await db
    .select({ projectId: tasks.projectId, at: max(tasks.updatedAt) })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, session.workspaceId), isNotNull(tasks.projectId)))
    .groupBy(tasks.projectId);
  const lastTask = new Map(activity.map((a) => [a.projectId, a.at ? new Date(a.at) : null]));
  const now = new Date();
  const withHealth = ps.map((p) => {
    const t = lastTask.get(p.id) ?? null;
    const last = t && t > p.updatedAt ? t : p.updatedAt;
    const done = ["done", "completed", "archived"].includes(p.status);
    return { ...p, lastActivityAt: last.toISOString(), ...projectHealth({ deadline: p.deadline, progress: p.progress, done, lastActivityAt: last, createdAt: p.createdAt }, tz, now) };
  });
  return { timezone: tz, clients: cs.map((c) => ({ ...c, projects: withHealth.filter((p) => p.clientId === c.id) })) };
});

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, clientInputSchema);
  const [c] = await db.insert(clients).values({ ...input, workspaceId: session.workspaceId }).returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "client.created", targetType: "client", targetId: c!.id, details: { name: c!.name } });
  return { client: c };
});
