import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, members, users, workspaces } from "@wfos/db";
import { body, route } from "@/lib/server/route";
import { serverEnv } from "@/lib/server/env";

export const GET = route("VIEWER", async ({ session }) => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const all = await db
    .select({ id: workspaces.id, name: workspaces.name, role: members.role })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(eq(members.userId, session.userId));
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, session.userId));
  return {
    user: { id: session.userId, email: session.email, name: session.name, mustChangePassword: session.mustChangePassword, hasPassword: !!u?.passwordHash },
    workspace: { id: ws!.id, name: ws!.name, killSwitch: ws!.killSwitch, demoMode: ws!.demoMode, guardsEnabled: ws!.guardsEnabled },
    role: session.role,
    workspaces: all,
    claude: { authMode: serverEnv.claudeAuthMode, credentialPresent: serverEnv.claudeCredentialPresent },
    googleEnabled: !!serverEnv.googleClientId,
  };
});

const profileSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(120) });

/** Update your own profile (display name). Email is the sign-in identity and stays fixed. */
export const PATCH = route("VIEWER", async ({ session, req }) => {
  const { name } = await body(req, profileSchema);
  await db.update(users).set({ name }).where(eq(users.id, session.userId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.profile_updated", targetType: "user", targetId: session.userId, details: { name } });
  return { ok: true };
});
