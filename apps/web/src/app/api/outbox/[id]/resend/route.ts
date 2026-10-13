import { and, eq } from "drizzle-orm";
import { audit, db, outboundEmails } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, route } from "@/lib/server/route";
import { q, redis } from "@/lib/server/queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Send a failed email again: the worker sends the stored payload as a new attempt (resendOf → this one), with the
 * email policy and the kill switch still applying. Only failed attempts, and each one only once (a failed resend
 * is itself a failed attempt that can be sent again).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, params }) => {
  if (!UUID.test(params.id)) notFound("outbox_not_found");
  const [row] = await db
    .select({ id: outboundEmails.id, status: outboundEmails.status, kind: outboundEmails.kind, to: outboundEmails.to, subject: outboundEmails.subject })
    .from(outboundEmails)
    .where(and(eq(outboundEmails.id, params.id), eq(outboundEmails.workspaceId, session.workspaceId)));
  if (!row) notFound("outbox_not_found");
  if (row.status !== "failed") throw new HttpError(409, "Only a failed email can be sent again", { code: "outbox_not_failed" });
  const [retry] = await db
    .select({ id: outboundEmails.id })
    .from(outboundEmails)
    // the worker resends a failed attempt only once: after that, the newer attempt is the one to retry
    .where(and(eq(outboundEmails.workspaceId, session.workspaceId), eq(outboundEmails.resendOf, row.id)))
    .limit(1);
  // a double click (or a second admin) before the worker has written its attempt
  const locked = (await redis().set(`outbox-resend:${row.id}`, session.userId, "PX", 60_000, "NX")) === null;
  if (retry || locked) throw new HttpError(409, "This email is already being sent again", { code: "outbox_already_resent" });
  await q.misc({ kind: "outbox_resend", emailId: row.id, workspaceId: session.workspaceId, userId: session.userId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "outbox.resend",
    targetType: "outbound_email",
    targetId: row.id,
    details: { kind: row.kind, to: row.to, subject: row.subject },
  });
  return { ok: true };
});
