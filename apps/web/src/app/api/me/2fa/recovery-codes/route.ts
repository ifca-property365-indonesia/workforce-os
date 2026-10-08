import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, users } from "@wfos/db";
import { generateRecoveryCodes } from "@wfos/shared/totp";
import { body, route } from "@/lib/server/route";
import { reauthenticate } from "@/lib/server/twofactor";

const schema = z.object({ password: z.string().optional(), code: z.string().optional() });

/** Replace all recovery codes (old ones stop working). Needs password + current code. */
export const POST = route("VIEWER", async ({ session, req }) => {
  const input = await body(req, schema);
  await reauthenticate(session.userId, input);
  const { codes, hashes } = generateRecoveryCodes();
  await db.update(users).set({ recoveryCodes: hashes }).where(eq(users.id, session.userId));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "user.recovery_codes_regenerated", targetType: "user", targetId: session.userId });
  return { ok: true, recoveryCodes: codes };
});
