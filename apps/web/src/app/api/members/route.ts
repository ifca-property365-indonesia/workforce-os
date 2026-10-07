import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, db, members, users } from "@wfos/db";
import { ROLES } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => {
  const rows = await db
    .select({ userId: users.id, email: users.email, name: users.name, role: members.role, createdAt: members.createdAt })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.workspaceId, session.workspaceId));
  return { members: rows };
});

const addSchema = z.object({ email: z.email(), name: z.string().min(1).max(120), role: z.enum(ROLES) });

/** Add a member. New users get a one-time temporary password shown once to the admin. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, addSchema);
  if (input.role === "OWNER" && session.role !== "OWNER") throw new HttpError(403, "Only an Owner can add Owners");
  const email = input.email.toLowerCase();
  let [u] = await db.select().from(users).where(eq(users.email, email));
  let tempPassword: string | null = null;
  if (!u) {
    tempPassword = randomBytes(9).toString("base64url");
    [u] = await db.insert(users).values({ email, name: input.name, passwordHash: await bcrypt.hash(tempPassword, 11) }).returning();
  }
  await db.insert(members).values({ workspaceId: session.workspaceId, userId: u!.id, role: input.role }).onConflictDoNothing();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "member.added", targetType: "user", targetId: u!.id, details: { email, role: input.role } });
  return { ok: true, tempPassword };
});

const roleSchema = z.object({ userId: z.string().uuid(), role: z.enum(ROLES) });

export const PATCH = route("OWNER", async ({ session, req }) => {
  const input = await body(req, roleSchema);
  if (input.userId === session.userId && input.role !== "OWNER") throw new HttpError(400, "You cannot demote yourself");
  await db.update(members).set({ role: input.role }).where(and(eq(members.workspaceId, session.workspaceId), eq(members.userId, input.userId)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "member.role_changed", targetType: "user", targetId: input.userId, details: { role: input.role } });
  return { ok: true };
});
