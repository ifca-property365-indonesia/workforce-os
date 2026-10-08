import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { loginSchema } from "@wfos/shared";
import { HttpError, setSession } from "@/lib/server/auth";
import { body, errorResponse } from "@/lib/server/route";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/server/ratelimit";
import { assertNotLocked, clearLoginFailures, lockedError, recordLoginFailure, setTwoFactorChallenge } from "@/lib/server/twofactor";

export async function POST(req: NextRequest) {
  try {
    const input = await body(req, loginSchema);
    const email = input.email.toLowerCase();
    // brute-force protection: 10 attempts / 15 min per account, 30 / 15 min per IP (password spraying),
    // plus a per-account lockout after 5 failed password or second-factor attempts
    const tooMany = "Too many attempts. Try again in 15 minutes.";
    await rateLimit(`login:ip:${clientIp(req)}`, 30, 900, tooMany);
    await rateLimit(`login:email:${email}`, 10, 900, tooMany);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (user) assertNotLocked(user);
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
      if (user) {
        const locked = await recordLoginFailure(user.id);
        if (locked) throw lockedError(locked);
      }
      throw new HttpError(401, "Invalid email or password", { code: "invalid_credentials" });
    }
    await resetRateLimit(`login:email:${email}`);
    if (user.totpSecretEnc) {
      // the password alone does not sign in: the second factor completes it at /api/auth/login/2fa
      await setTwoFactorChallenge(user.id);
      return NextResponse.json({ ok: true, twoFactorRequired: true });
    }
    await clearLoginFailures(user.id);
    await setSession(user.id);
    return NextResponse.json({ ok: true, mustChangePassword: user.mustChangePassword });
  } catch (e) {
    return errorResponse(e, req);
  }
}
