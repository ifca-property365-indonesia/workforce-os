import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { appTests, db } from "@wfos/db";
import { loadApp } from "@/lib/server/apps";
import { serverEnv } from "@/lib/server/env";
import { notFound, route } from "@/lib/server/route";

/** A screenshot the tester's browser took (#n in its report). */
export const GET = route<{ id: string; testId: string; n: string }>("MEMBER", async ({ session, params }) => {
  if (!/^[1-9][0-9]{0,4}$/.test(params.n)) notFound();
  const app = await loadApp(session.workspaceId, params.id);
  const [t] = await db.select({ id: appTests.id }).from(appTests).where(and(eq(appTests.id, params.testId), eq(appTests.appId, app.id), eq(appTests.workspaceId, session.workspaceId)));
  if (!t) notFound("app_test_not_found");
  const png = await readFile(path.resolve(serverEnv.storageDir, "app-tests", t.id, `${params.n}.png`)).catch(() => null);
  if (!png) notFound();
  return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
});
