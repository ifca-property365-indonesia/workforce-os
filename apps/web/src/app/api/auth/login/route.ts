import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { loginSchema } from "@wfos/shared";
import { HttpError, setSession } from "@/lib/server/auth";
import { body, errorResponse } from "@/lib/server/route";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/server/ratelimit";

export async function POST(req: NextRequest) {
  try {
    const input = await body(req, loginSchema);
    const email = input.email.toLowerCase();
    // brute-force protection: 10 attempts / 15 min per account, 30 / 15 min per IP (password spraying)
    const tooMany = "Too many attempts. Try again in 15 minutes.";
    await rateLimit(`login:ip:${clientIp(req)}`, 30, 900, tooMany);
    await rateLimit(`login:email:${email}`, 10, 900, tooMany);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) throw new HttpError(401, "Invalid email or password");
    await resetRateLimit(`login:email:${email}`);
    await setSession(user.id);
    return NextResponse.json({ ok: true, mustChangePassword: user.mustChangePassword });
  } catch (e) {
    return errorResponse(e, req);
  }
}
