import { eq, sql } from "drizzle-orm";
import { audit, db, workspaces } from "@wfos/db";
import { emailPolicySchema, parseEmailPolicy } from "@wfos/shared";
import { patchBody, route } from "@/lib/server/route";

async function current(workspaceId: string) {
  const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return parseEmailPolicy(ws?.settings);
}

/** Outgoing agent email policy (workspaces.settings.email): pause and a daily limit. Notifications are not affected. */
export const GET = route("MEMBER", async ({ session }) => ({ policy: await current(session.workspaceId) }));

export const PUT = route("ADMIN", async ({ session, req }) => {
  // only the keys sent: a missing key keeps its stored value (Zod defaults would reset it)
  const input = await patchBody(req, emailPolicySchema);
  const before = await current(session.workspaceId);
  const policy = emailPolicySchema.parse({ ...before, ...input });
  // merge in SQL: the other settings keys (company profile, …) are never overwritten, even by a concurrent save
  await db
    .update(workspaces)
    .set({ settings: sql`coalesce(${workspaces.settings}, '{}'::jsonb) || jsonb_build_object('email', ${JSON.stringify(policy)}::jsonb)` })
    .where(eq(workspaces.id, session.workspaceId));
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "settings.email_policy_changed",
    targetType: "workspace",
    targetId: session.workspaceId,
    details: { before, after: policy },
  });
  return { policy };
});
