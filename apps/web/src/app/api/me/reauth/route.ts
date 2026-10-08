import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";
import { reauthenticate, setStepUp } from "@/lib/server/twofactor";

const schema = z.object({ password: z.string().optional(), code: z.string().optional() });

/** Step-up re-authentication (password + TOTP) for sensitive changes; valid for 10 minutes. */
export const POST = route("VIEWER", async ({ session, req }) => {
  if (!session.twoFactorEnabled) throw new HttpError(403, "Set up two-factor authentication first", { code: "two_factor_required" });
  const input = await body(req, schema);
  if (!input.code) throw new HttpError(400, "Enter the code from your authenticator app", { code: "invalid_code" });
  await reauthenticate(session.userId, input);
  return { ok: true, until: (await setStepUp(session.userId)).toISOString() };
});
