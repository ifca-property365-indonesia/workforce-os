import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db, users } from "@wfos/db";
import { encryptSecret } from "@wfos/shared/server";
import { generateTotpSecret, otpauthUri } from "@wfos/shared/totp";
import { HttpError } from "@/lib/server/auth";
import { route } from "@/lib/server/route";

/** Start enrollment: a new secret is stored as pending until the first valid code confirms it. */
export const POST = route("VIEWER", async ({ session }) => {
  const [u] = await db.select({ enabled: users.totpSecretEnc }).from(users).where(eq(users.id, session.userId));
  if (u?.enabled) throw new HttpError(409, "Two-factor authentication is already on", { code: "two_factor_already_enabled" });
  const secret = generateTotpSecret();
  await db.update(users).set({ totpPendingEnc: encryptSecret(secret) }).where(eq(users.id, session.userId));
  const uri = otpauthUri({ secret, account: session.email, issuer: "Workforce OS" });
  return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
});
