import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, members, workspaces } from "@wfos/db";

/** True when the user is OWNER/ADMIN of any workspace that requires 2FA for admins. */
export async function twoFactorRequiredFor(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: members.workspaceId })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.userId, userId), inArray(members.role, ["OWNER", "ADMIN"]), eq(workspaces.require2faAdmins, true)));
  return rows.length > 0;
}
