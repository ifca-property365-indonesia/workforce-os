import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, db, members, users } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ userId: z.string().uuid() });

/**
 * Issue a new temporary password for a member (stand-in for "forgot password").
 * Only for accounts that belong to this workspace alone: an admin here must not be able
 * to take over an account that also holds a role in another workspace.
 */
export const POST = route("ADMIN", async ({ session, req }) => {
  const { userId } = await body(req, schema);
  if (userId === session.userId) throw new HttpError(400, "Use Account → Change password for your own account", { code: "reset_own_password" });
  const [target] = await db.select().from(members).where(and(eq(members.workspaceId, session.workspaceId), eq(members.userId, userId)));
  if (!target) notFound("member_not_found");
  if (target.role === "OWNER" && session.role !== "OWNER") throw new HttpError(403, "Only an Owner can reset an Owner's password", { code: "owner_only_reset_owner" });
  const all = await db.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.userId, userId));
  if (all.some((m) => m.workspaceId !== session.workspaceId)) throw new HttpError(403, "This user also belongs to another workspace", { code: "reset_multi_workspace_user" });
  const tempPassword = randomBytes(9).toString("base64url");
  const [u] = await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(tempPassword, 11), mustChangePassword: true, passwordChangedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ email: users.email });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "member.password_reset", targetType: "user", targetId: userId, details: { email: u!.email } });
  return { ok: true, tempPassword };
});
