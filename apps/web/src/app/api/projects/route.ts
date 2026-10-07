import { and, eq } from "drizzle-orm";
import { clients, db, projects } from "@wfos/db";
import { projectInputSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, projectInputSchema);
  const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, input.clientId), eq(clients.workspaceId, session.workspaceId)));
  if (!c) throw new HttpError(400, "Unknown client");
  const [p] = await db.insert(projects).values({ ...input, workspaceId: session.workspaceId }).returning();
  return { project: p };
});
