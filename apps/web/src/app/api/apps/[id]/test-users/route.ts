import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { appTestUsers, audit, db } from "@wfos/db";
import { testUserSchema } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { HttpError } from "@/lib/server/auth";
import { loadApp, loadEnv } from "@/lib/server/apps";
import { body, notFound, route } from "@/lib/server/route";

/**
 * C10: the preview's test accounts per role (no secrets here: POST …/reveal shows a password and the current
 * two-factor code). auto rows come from the app's testUsers script on each preview release; manual ones from a person.
 */
export const GET = route<{ id: string }>("MEMBER", async ({ session, params }) => {
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  const rows = await db.select().from(appTestUsers).where(eq(appTestUsers.environmentId, env.id)).orderBy(asc(appTestUsers.role));
  return {
    users: rows.map((r) => ({
      role: r.role,
      label: r.label,
      username: r.username,
      loginPath: r.loginPath,
      source: r.source,
      viewAll: r.viewAll,
      note: r.note,
      hasTotp: !!r.totpEnc,
      ownPassword: !!r.passwordEnc,
      updatedAt: r.updatedAt,
    })),
    lastRunAt: env.testUsersAt,
    lastRunNote: env.testUsersNote,
    sharedPassword: !!env.testPasswordEnc,
  };
});

const addSchema = testUserSchema.extend({ password: z.string().min(4).max(200).optional() });

/** A test account added by hand (kept across releases; it wins over the script's account of the same role). */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const u = await body(req, addSchema);
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  if (!u.password && !env.testPasswordEnc) throw new HttpError(400, "This preview has no shared test password yet: give the account its own", { code: "test_password_required" });
  const values = {
    label: u.label,
    username: u.username,
    passwordEnc: u.password ? encryptSecret(u.password) : null,
    totpEnc: u.totp ? encryptSecret(u.totp) : null,
    loginPath: u.loginPath,
    source: "manual" as const,
    viewAll: u.viewAll,
    note: u.note,
    updatedAt: new Date(),
  };
  await db
    .insert(appTestUsers)
    .values({ environmentId: env.id, workspaceId: session.workspaceId, role: u.role, ...values })
    .onConflictDoUpdate({ target: [appTestUsers.environmentId, appTestUsers.role], set: values });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_user_saved", targetType: "app", targetId: app.id, details: { name: app.name, role: u.role, username: u.username } });
  return { ok: true };
});

/** Remove one (an auto account comes back on the next preview release while the script still makes it). */
export const DELETE = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const role = req.nextUrl.searchParams.get("role") ?? "";
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  const [gone] = await db.delete(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.role, role))).returning({ role: appTestUsers.role });
  if (!gone) notFound("test_user_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_user_removed", targetType: "app", targetId: app.id, details: { name: app.name, role } });
  return { ok: true };
});
