import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { audit, db, members, seedPrices, seedSampleData, users, workspaces } from "@wfos/db";
import { signupSchema } from "@wfos/shared";
import { z } from "zod";
import { setSession } from "@/lib/server/auth";
import { body, errorResponse } from "@/lib/server/route";
import { HttpError } from "@/lib/server/auth";
import { signupAllowed } from "@/lib/server/signup";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";

const schema = signupSchema.extend({ sampleData: z.boolean().default(true) });

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export async function POST(req: NextRequest) {
  try {
    if (!(await signupAllowed())) throw new HttpError(403, "Self-service signup is disabled on this server.", { code: "signup_disabled" });
    await rateLimit(`signup:ip:${clientIp(req)}`, 5, 3600, "too_many_signups");
    const input = await body(req, schema);
    const email = input.email.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new HttpError(409, "An account with this email already exists", { code: "email_taken" });
    const [user] = await db.insert(users).values({ email, name: input.name, passwordHash: await bcrypt.hash(input.password, 11) }).returning();
    const [ws] = await db
      .insert(workspaces)
      .values({ name: input.workspaceName, slug: `${slugify(input.workspaceName)}-${Math.random().toString(36).slice(2, 7)}`, notifyEmail: email })
      .returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: user!.id, role: "OWNER" });
    await seedPrices(db);
    if (input.sampleData) await seedSampleData(db, ws!.id);
    await audit({ workspaceId: ws!.id, actorUserId: user!.id, actorLabel: email, action: "workspace.created", targetType: "workspace", targetId: ws!.id });
    await setSession(user!.id, ws!.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e, req);
  }
}
