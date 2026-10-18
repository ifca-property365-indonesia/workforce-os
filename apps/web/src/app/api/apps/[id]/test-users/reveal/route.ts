import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appTestUsers, audit, db } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { totp } from "@wfos/shared/totp";
import { loadApp, loadEnv } from "@/lib/server/apps";
import { rateLimit } from "@/lib/server/ratelimit";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ role: z.string().min(1).max(40) });

/**
 * The password of a preview test account and, when it has two-factor, the code valid now (and how long it still is).
 * Admins, like the preview's own login; every view is audited. The TOTP key itself never leaves the server.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { role } = await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const env = await loadEnv(session.workspaceId, app.id, "preview");
  await rateLimit(`app-test-users:${session.userId}`, 60, 300);
  const [u] = await db.select().from(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.role, role)));
  if (!u) notFound("test_user_not_found");
  const enc = u.passwordEnc ?? env.testPasswordEnc;
  if (!enc) notFound("test_password_missing");
  const now = Date.now();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_user_viewed", targetType: "app", targetId: app.id, details: { name: app.name, role, username: u.username } });
  return {
    username: u.username,
    password: decryptSecret(enc),
    code: u.totpEnc ? totp(decryptSecret(u.totpEnc), now) : null,
    // seconds until the code changes (30-second steps)
    codeValidFor: u.totpEnc ? 30 - Math.floor((now / 1000) % 30) : null,
    loginPath: u.loginPath,
  };
});
