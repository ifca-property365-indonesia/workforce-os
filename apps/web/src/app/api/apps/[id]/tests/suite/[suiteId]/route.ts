import { z } from "zod";
import { audit, db, stopAppTestSuite } from "@wfos/db";
import { loadApp } from "@/lib/server/apps";
import { body, notFound, route } from "@/lib/server/route";

const schema = z.object({ action: z.literal("stop") });

/** Stop a full test: packages not started yet are cancelled; the one running finishes (cancel its task to end it now). */
export const POST = route<{ id: string; suiteId: string }>("ADMIN", async ({ session, req, params }) => {
  await body(req, schema);
  const app = await loadApp(session.workspaceId, params.id);
  if (!(await stopAppTestSuite(db, session.workspaceId, params.suiteId))) notFound("app_test_suite_not_found");
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "app.test_suite_stopped", targetType: "app", targetId: app.id, details: { name: app.name, suiteId: params.suiteId } });
  return { ok: true };
});
