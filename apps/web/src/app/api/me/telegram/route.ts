import { eq } from "drizzle-orm";
import { audit, db, telegramLinkCodes, users } from "@wfos/db";
import { newLinkCode, telegramConfigured } from "@wfos/shared/telegram";
import { HttpError } from "@/lib/server/auth";
import { route } from "@/lib/server/route";
import { rateLimit } from "@/lib/server/ratelimit";

/** Start linking: a one-time code (10 minutes) the user sends to the bot as `/link CODE`. */
export const POST = route("VIEWER", async ({ session }) => {
  if (!telegramConfigured()) throw new HttpError(409, "Telegram is not configured on this server", { code: "telegram_not_configured" });
  await rateLimit(`tg-link:${session.userId}`, 10, 3600);
  const { code, hash } = newLinkCode();
  await db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.userId, session.userId));
  await db.insert(telegramLinkCodes).values({ codeHash: hash, userId: session.userId, expiresAt: new Date(Date.now() + 10 * 60_000) });
  return { code, bot: process.env.TELEGRAM_BOT_USERNAME ?? null, expiresInMinutes: 10 };
});

export const DELETE = route("VIEWER", async ({ session }) => {
  await db.update(users).set({ telegramChatId: null }).where(eq(users.id, session.userId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.telegram_unlinked", targetType: "user", targetId: session.userId });
  return { ok: true };
});
