import { eq, sql } from "drizzle-orm";
import { audit, db, workspaces } from "@wfos/db";
import { companyProfileSchema, parseCompanyProfile } from "@wfos/shared";
import { patchBody, route } from "@/lib/server/route";

async function current(workspaceId: string) {
  const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return parseCompanyProfile(ws?.settings);
}

/** The company profile printed on invoices (workspaces.settings.company). */
export const GET = route("MEMBER", async ({ session }) => ({ company: await current(session.workspaceId) }));

/** Fields not sent keep their value; other settings keys (e.g. `email`) are never touched. */
export const PUT = route("ADMIN", async ({ session, req }) => {
  const input = await patchBody(req, companyProfileSchema.partial());
  const company = companyProfileSchema.parse({ ...(await current(session.workspaceId)), ...input });
  // jsonb `||` replaces only the `company` key, so a concurrent save of another settings key is not lost
  await db
    .update(workspaces)
    .set({ settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || ${JSON.stringify({ company })}::jsonb` })
    .where(eq(workspaces.id, session.workspaceId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "settings.company_updated", targetType: "workspace", targetId: session.workspaceId, details: { fields: Object.keys(input) } });
  return { company };
});
