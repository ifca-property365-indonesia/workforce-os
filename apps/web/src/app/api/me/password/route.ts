import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, db, users } from "@wfos/db";
import { HttpError, setSession } from "@/lib/server/auth";
import { rateLimit, resetRateLimit } from "@/lib/server/ratelimit";
import { body, route } from "@/lib/server/route";

const schema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(10, "Use at least 10 characters").max(200),
});

/** Change your own password. Revokes every other session (see getSession). */
export const POST = route("VIEWER", async ({ session, req }) => {
  const input = await body(req, schema);
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user) throw new HttpError(404, "User not found");
  // Google-only accounts have no password yet and may set one without a current password
  if (user.passwordHash) {
    await rateLimit(`pwchange:${user.id}`, 10, 900, "Too many attempts. Try again in 15 minutes.");
    if (!input.currentPassword || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    if (await bcrypt.compare(input.newPassword, user.passwordHash)) throw new HttpError(400, "The new password must be different from the current one");
  }
  await db
    .update(users)
    .set({ passwordHash: await bcrypt.hash(input.newPassword, 11), mustChangePassword: false, passwordChangedAt: new Date() })
    .where(eq(users.id, user.id));
  await resetRateLimit(`pwchange:${user.id}`);
  await audit({ workspaceId: session.workspaceId, actorUserId: user.id, actorLabel: user.email, action: "user.password_changed", targetType: "user", targetId: user.id });
  // re-issue this browser's session so only the other sessions are signed out
  await setSession(user.id, session.workspaceId);
  return { ok: true };
});
