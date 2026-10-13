import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** 200 when the app runs and its database answers (Workforce OS checks this before and after publishing). */
export async function GET() {
  try {
    await sql()`SELECT 1`;
    return Response.json({ ok: true, version: process.env.APP_VERSION ?? null });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
