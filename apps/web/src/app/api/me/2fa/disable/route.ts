import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, users } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { reauthenticate } from "@/lib/server/twofactor";
import { twoFactorRequiredFor } from "@/lib/server/twofactor-policy";

const schema = z.object({ password: z.string().optional(), code: z.string().optional(), recoveryCode: z.string().optional() });

/** Turning 2FA off needs the password and a current code, and is refused while a workspace requires it. */
export const POST = route("VIEWER", async ({ session, req }) => {
  const input = await body(req, schema);
  if (await twoFactorRequiredFor(session.userId)) {
    throw new HttpError(403, "Your role in a workspace requires two-factor authentication", { code: "two_factor_required_by_workspace" });
  }
  await reauthenticate(session.userId, input);
  await db
    .update(users)
    .set({ totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastCounter: null, recoveryCodes: [] })
    .where(eq(users.id, session.userId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.2fa_disabled", targetType: "user", targetId: session.userId });
  return { ok: true };
});
