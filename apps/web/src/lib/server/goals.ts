import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, goals, teams } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";

/** P1: a goal as an Admin writes it */
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(""),
  parentId: z.string().uuid().nullable().default(null),
  teamId: z.string().uuid().nullable().default(null),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

/** a parent and a division given must be this workspace's */
export async function checkGoalRefs(workspaceId: string, i: { parentId?: string | null; teamId?: string | null }) {
  if (i.parentId) {
    const [p] = await db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, i.parentId), eq(goals.workspaceId, workspaceId)));
    if (!p) throw new HttpError(400, "Unknown goal", { code: "unknown_goal" });
  }
  if (i.teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, i.teamId), eq(teams.workspaceId, workspaceId)));
    if (!t) throw new HttpError(400, "Unknown division", { code: "unknown_team" });
  }
}

