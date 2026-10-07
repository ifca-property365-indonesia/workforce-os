import { and, eq } from "drizzle-orm";
import { audit, credentials, db } from "@wfos/db";
import { smtpSettingsSchema } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { body, route } from "@/lib/server/route";

const where = (ws: string) => and(eq(credentials.workspaceId, ws), eq(credentials.kind, "smtp"), eq(credentials.name, "default"));

export const GET = route("ADMIN", async ({ session }) => {
  const [c] = await db.select().from(credentials).where(where(session.workspaceId));
  // the password never leaves the server
  return { smtp: c ? { ...(c.config as object), passwordSet: !!c.secretEnc } : null };
});

export const PUT = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, smtpSettingsSchema);
  const { password, ...config } = input;
  const [existing] = await db.select().from(credentials).where(where(session.workspaceId));
  const secretEnc = password ? encryptSecret(password) : (existing?.secretEnc ?? null);
  if (existing) await db.update(credentials).set({ config, secretEnc }).where(eq(credentials.id, existing.id));
  else await db.insert(credentials).values({ workspaceId: session.workspaceId, kind: "smtp", name: "default", config, secretEnc });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.smtp_changed", targetType: "credential", targetId: "smtp", details: { host: config.host, port: config.port, user: config.user, passwordChanged: !!password } });
  return { ok: true };
});
