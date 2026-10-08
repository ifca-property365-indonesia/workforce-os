import { eq } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { route } from "@/lib/server/route";
import { twoFactorRequiredFor } from "@/lib/server/twofactor-policy";

export const GET = route("VIEWER", async ({ session }) => {
  const [u] = await db.select().from(users).where(eq(users.id, session.userId));
  return {
    enabled: !!u?.totpSecretEnc,
    enabledAt: u?.totpEnabledAt ?? null,
    required: await twoFactorRequiredFor(session.userId),
    recoveryCodesLeft: u?.recoveryCodes.length ?? 0,
    hasPassword: !!u?.passwordHash,
  };
});
