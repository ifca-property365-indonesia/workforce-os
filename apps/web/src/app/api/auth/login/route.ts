import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { loginSchema } from "@wfos/shared";
import { HttpError, setSession } from "@/lib/server/auth";
import { body, errorResponse } from "@/lib/server/route";
import { redis } from "@/lib/server/queue";

export async function POST(req: NextRequest) {
  try {
    const input = await body(req, loginSchema);
    const email = input.email.toLowerCase();
    // basic brute-force protection: 10 attempts / 15 min per email
    const key = `wfos:login:${email}`;
    const attempts = await redis().incr(key);
    if (attempts === 1) await redis().expire(key, 900);
    if (attempts > 10) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) throw new HttpError(401, "Invalid email or password");
    await redis().del(key);
    await setSession(user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e, req);
  }
}
