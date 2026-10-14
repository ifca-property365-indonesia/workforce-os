import { approvalDecisionSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { decideApproval } from "@/lib/server/approvals";
import { requireStepUp } from "@/lib/server/twofactor";

/** Per-action human decision (Approvals page). A LIVE release (request_release) is the Owner's, with a fresh step-up. */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const input = await body(req, approvalDecisionSchema);
  return decideApproval(
    { userId: session.userId, email: session.email, workspaceId: session.workspaceId, via: "web", role: session.role, stepUp: () => requireStepUp(session) },
    params.id,
    input,
  );
});
