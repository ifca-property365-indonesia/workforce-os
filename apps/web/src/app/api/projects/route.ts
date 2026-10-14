import { and, eq } from "drizzle-orm";
import { clients, db, projects } from "@wfos/db";
import { projectInputSchema } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { assertWorkspaceTeam } from "@/lib/server/teams";

export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, projectInputSchema);
  const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, input.clientId), eq(clients.workspaceId, session.workspaceId)));
  if (!c) throw new HttpError(400, "Unknown client", { code: "unknown_client" });
  // the responsible division must be one of this workspace's
  await assertWorkspaceTeam(session.workspaceId, input.teamId);
  // a status given at creation is a status update too
  const hasStatus = input.health !== "on_track" || !!input.nextMilestone || !!input.nextStep;
  const [p] = await db
    .insert(projects)
    .values({ ...input, workspaceId: session.workspaceId, statusUpdatedAt: hasStatus ? new Date() : null })
    .returning();
  return { project: p };
});
