import { NextResponse } from "next/server";
import { getSql } from "@wfos/db";
import { redis } from "@/lib/server/queue";

export async function GET() {
  try {
    await getSql()`select 1`;
    await redis().ping();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
