import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, employees, replays } from "@wfos/db";
import { body, notFound, route } from "@/lib/server/route";
import { q } from "@/lib/server/queue";

type P = { id: string };
const schema = z.object({ instructions: z.string().max(20000), persona: z.string().max(4000), businessContext: z.string().max(20000), sampleSize: z.number().int().min(1).max(10).default(3) });

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const rows = await db
    .select()
    .from(replays)
    .where(and(eq(replays.employeeId, params.id), eq(replays.workspaceId, session.workspaceId)))
    .orderBy(desc(replays.createdAt))
    .limit(10);
  return { replays: rows };
});

export const POST = route<P>("ADMIN", async ({ session, req, params }) => {
  const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, params.id), eq(employees.workspaceId, session.workspaceId)));
  if (!e) notFound();
  const { sampleSize, ...proposed } = await body(req, schema);
  const [r] = await db.insert(replays).values({ workspaceId: session.workspaceId, employeeId: e.id, proposed, sampleSize, createdBy: session.userId }).returning();
  await q.misc({ kind: "replay", replayId: r!.id, workspaceId: session.workspaceId });
  return { replay: r };
});
