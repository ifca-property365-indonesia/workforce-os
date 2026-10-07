import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/server/env";
import { signupAllowed } from "@/lib/server/signup";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ signup: await signupAllowed(), google: !!serverEnv.googleClientId });
}
