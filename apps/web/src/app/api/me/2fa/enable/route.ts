import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, users } from "@wfos/db";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { generateRecoveryCodes, verifyTotp } from "@wfos/shared/totp";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { rateLimit } from "@/lib/server/ratelimit";

const schema = z.object({ code: z.string().min(6).max(10) });

/** Confirm enrollment with the first code. Recovery codes are returned once and only their hashes are stored. */
export const POST = route("VIEWER", async ({ session, req }) => {
  await rateLimit(`2fa-enable:${session.userId}`, 10, 900, "Too many attempts. Try again in 15 minutes.");
  const { code } = await body(req, schema);
  const [u] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!u?.totpPendingEnc) throw new HttpError(400, "Start the setup first", { code: "two_factor_setup_missing" });
  const secret = decryptSecret(u.totpPendingEnc);
  const counter = verifyTotp(secret, code);
  if (counter == null) throw new HttpError(400, "The code is not valid", { code: "invalid_code" });
  const { codes, hashes } = generateRecoveryCodes();
  await db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret), totpPendingEnc: null, totpEnabledAt: new Date(), totpLastCounter: counter, recoveryCodes: hashes })
    .where(eq(users.id, session.userId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.2fa_enabled", targetType: "user", targetId: session.userId });
  return { ok: true, recoveryCodes: codes };
});
