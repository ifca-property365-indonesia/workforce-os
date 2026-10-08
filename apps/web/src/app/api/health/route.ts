import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, employees, getSql } from "@wfos/db";
import { evaluateHealth, heartbeatKey, type WorkerHeartbeat } from "@wfos/shared/ops";
import { wfosNamespace } from "@wfos/shared/runtime";
import { redis } from "@/lib/server/queue";

async function check<T>(f: () => Promise<T>): Promise<{ ok: boolean; value: T | null }> {
  try {
    return { ok: true, value: await f() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Health for load balancers, Docker and deploy/upgrade.sh. Public, so it reports booleans only (no error text or
 * addresses). 503 when the web cannot serve (db/redis); with ?strict=1 also when degraded (worker or sandbox).
 */
export async function GET(req: NextRequest) {
  const [dbc, redisc] = await Promise.all([check(() => getSql()`select 1`), check(() => redis().ping())]);
  const hb = redisc.ok ? await check(() => redis().get(heartbeatKey(wfosNamespace()))) : { ok: false, value: null };
  let heartbeat: WorkerHeartbeat | null = null;
  try {
    heartbeat = hb.value ? (JSON.parse(hb.value) as WorkerHeartbeat) : null;
  } catch {
    heartbeat = null;
  }
  const ws = dbc.ok ? await check(() => db.select({ id: employees.id }).from(employees).where(eq(employees.executionMode, "workspace")).limit(1)) : { ok: false, value: null };
  const report = evaluateHealth({ db: dbc.ok, redis: redisc.ok, heartbeat, workspaceModeInUse: !!ws.value?.length, now: Date.now() });
  const strict = req.nextUrl.searchParams.get("strict") === "1";
  const code = report.status === "down" || (strict && report.status !== "ok") ? 503 : 200;
  return NextResponse.json({ ok: report.status === "ok", ...report }, { status: code, headers: { "Cache-Control": "no-store" } });
}
