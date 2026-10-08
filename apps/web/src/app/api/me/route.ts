import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, claudeCredentialStatus, db, members, users, workspaces } from "@wfos/db";
import { patchBody, route } from "@/lib/server/route";
import { LOCALES } from "@wfos/shared";
import { setLocaleCookie } from "@/lib/server/locale-cookie";
import { claudeSummary } from "@/lib/server/claude";
import { serverEnv } from "@/lib/server/env";
import { telegramConfigured } from "@wfos/shared/telegram";

export const GET = route("VIEWER", async ({ session }) => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
  const all = await db
    .select({ id: workspaces.id, name: workspaces.name, role: members.role })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(eq(members.userId, session.userId));
  const [u] = await db.select({ passwordHash: users.passwordHash, locale: users.locale, telegram: users.telegramChatId }).from(users).where(eq(users.id, session.userId));
  return {
    user: {
      id: session.userId,
      email: session.email,
      name: session.name,
      mustChangePassword: session.mustChangePassword,
      hasPassword: !!u?.passwordHash,
      twoFactorEnabled: session.twoFactorEnabled,
      mustEnroll2fa: session.mustEnroll2fa,
      locale: u?.locale ?? null,
      telegramLinked: !!u?.telegram,
    },
    telegramEnabled: telegramConfigured(),
    workspace: { id: ws!.id, name: ws!.name, killSwitch: ws!.killSwitch, demoMode: ws!.demoMode, guardsEnabled: ws!.guardsEnabled, defaultLocale: ws!.defaultLocale },
    role: session.role,
    workspaces: all,
    claude: claudeSummary(await claudeCredentialStatus(session.workspaceId)),
    googleEnabled: !!serverEnv.googleClientId,
  };
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** UI language; null = follow the workspace default */
  locale: z.enum(LOCALES).nullable().optional(),
});

/** Update your own profile (display name, language). Email is the sign-in identity and stays fixed. */
export const PATCH = route("VIEWER", async ({ session, req }) => {
  const input = await patchBody(req, profileSchema);
  const set: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.locale !== undefined) set.locale = input.locale;
  if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, session.userId));
  if (input.locale !== undefined) await setLocaleCookie(input.locale);
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.profile_updated", targetType: "user", targetId: session.userId, details: set });
  return { ok: true };
});
