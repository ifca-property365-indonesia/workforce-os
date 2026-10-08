import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, members, users } from "@wfos/db";
import { HttpError, setSession } from "@/lib/server/auth";
import { body, errorResponse } from "@/lib/server/route";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";
import {
  assertNotLocked,
  clearLoginFailures,
  clearTwoFactorChallenge,
  lockedError,
  readTwoFactorChallenge,
  recordLoginFailure,
  verifySecondFactor,
} from "@/lib/server/twofactor";

const schema = z.union([z.object({ code: z.string().min(6).max(10) }), z.object({ recoveryCode: z.string().min(8).max(20) })]);

/** Second login step: the password was accepted, now the TOTP or a recovery code completes the sign-in. */
export async function POST(req: NextRequest) {
  try {
    await rateLimit(`login2fa:ip:${clientIp(req)}`, 30, 900);
    const userId = await readTwoFactorChallenge();
    if (!userId) throw new HttpError(401, "Sign-in expired. Enter your password again.", { code: "two_factor_challenge_expired" });
    const input = await body(req, schema);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new HttpError(401, "Sign-in expired. Enter your password again.", { code: "two_factor_challenge_expired" });
    assertNotLocked(user);
    const used = await verifySecondFactor(user, input);
    if (!used) {
      const locked = await recordLoginFailure(user.id);
      if (locked) {
        await clearTwoFactorChallenge();
        throw lockedError(locked);
      }
      throw new HttpError(401, "The code is not valid", { code: "invalid_code" });
    }
    await clearLoginFailures(user.id);
    await clearTwoFactorChallenge();
    if (used === "recovery") {
      const ms = await db.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.userId, user.id));
      for (const m of ms) await audit({ workspaceId: m.workspaceId, actorUserId: user.id, actorLabel: user.email, action: "user.recovery_code_used", targetType: "user", targetId: user.id });
    }
    await setSession(user.id);
    return NextResponse.json({ ok: true, mustChangePassword: user.mustChangePassword, recoveryCodesLeft: used === "recovery" ? user.recoveryCodes.length - 1 : undefined });
  } catch (e) {
    return errorResponse(e, req);
  }
}
