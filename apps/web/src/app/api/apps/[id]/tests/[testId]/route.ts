import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { appTests, audit, db } from "@wfos/db";
import { loadApp } from "@/lib/server/apps";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ action: z.literal("handled") });

/** A person dealt with a test's findings (made fix tasks, or decided they need none): it leaves "Needs a decision". */
export const POST = route<{ id: string; testId: string }>("MEMBER", async ({ session, req, params }) => {
  await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  const [row] = await db
    .update(appTests)
    .set({ handledAt: new Date(), handledBy: session.userId })
    .where(and(eq(appTests.id, params.testId), eq(appTests.appId, app.id), eq(appTests.workspaceId, session.workspaceId), isNull(appTests.handledAt)))
    .returning({ id: appTests.id, findings: appTests.findings });
  if (!row) notFound("app_test_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_handled", targetType: "app", targetId: app.id, details: { name: app.name, testId: row.id, findings: row.findings.length } });
  return { ok: true };
});
