import { approvalDecisionSchema } from "@wfos/shared";
import { body, route } from "@/lib/server/route";
import { decideApproval } from "@/lib/server/approvals";

/** Per-action human decision (Approvals page). */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const input = await body(req, approvalDecisionSchema);
  return decideApproval({ userId: session.userId, email: session.email, workspaceId: session.workspaceId, via: "web" }, params.id, input);
});
