import { eq } from "drizzle-orm";
import { db, members, users, workspaces } from "@wfos/db";
import { route } from "@/lib/server/route";
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
