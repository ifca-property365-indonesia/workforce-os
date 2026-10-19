import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, teams } from "@wfos/db";
import { suggestDivision } from "@wfos/shared/division-routing";
import { body, route } from "@/lib/server/route";

const schema = z.object({ text: z.string().max(8000) });

/** Which division this text sounds like (only divisions with a head can take work), with the words that decided. */
export const POST = route("MEMBER", async ({ session, req }) => {
  const { text } = await body(req, schema);
  const divisions = await db
    .select({ id: teams.id, key: teams.key, name: teams.name, description: teams.description })
    .from(teams)
    .where(and(eq(teams.workspaceId, session.workspaceId), isNotNull(teams.leadId)));
  const s = suggestDivision(text, divisions);
  return { suggestion: s ? { ...s, name: divisions.find((d) => d.id === s.id)!.name } : null };
});
