import { and, asc, eq, inArray } from "drizzle-orm";
import { approvals, conversations, db, messages } from "@wfos/db";
import type { ChatApprovalDTO, ChatMessageDTO } from "@wfos/shared";
import { notFound, route } from "@/lib/server/route";

type P = { id: string };
type GuardFinding = ChatApprovalDTO["guardFindings"][number];
const SEVERITIES = new Set<string>(["low", "medium", "high"]);

/** The stored jsonb is untyped: keep only well-formed findings, so the card never renders garbage. */
function guardFindingsOf(raw: unknown): GuardFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g): GuardFinding[] => {
    if (!g || typeof g !== "object") return [];
    const { rule, severity, excerpt } = g as Record<string, unknown>;
    if (typeof rule !== "string" || typeof severity !== "string" || !SEVERITIES.has(severity)) return [];
    return [{ rule, severity: severity as GuardFinding["severity"], excerpt: typeof excerpt === "string" ? excerpt : "" }];
  });
}

export const GET = route<P>("VIEWER", async ({ session, params }) => {
  const [c] = await db.select().from(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  if (!c) notFound();
  const ms = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.createdAt), asc(messages.id));
  // approvals a chat run raised, shown inline under the assistant message that raised them
  const ids = ms.map((m) => m.id);
  const rows = ids.length
    ? await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.workspaceId, session.workspaceId), inArray(approvals.messageId, ids)))
        .orderBy(asc(approvals.createdAt), asc(approvals.id))
    : [];
  const byMessage = new Map<string, ChatApprovalDTO[]>();
  for (const a of rows) {
    const list = byMessage.get(a.messageId!) ?? [];
    list.push({
      id: a.id,
      toolName: a.toolName,
      title: a.title,
      reason: a.reason,
      status: a.status,
      payload: a.payload,
      editedPayload: a.editedPayload,
      feedback: a.feedback,
      executionResult: a.executionResult,
      guardFindings: guardFindingsOf(a.guardFindings),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    });
    byMessage.set(a.messageId!, list);
  }
  const out: ChatMessageDTO[] = ms.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    employeeId: m.employeeId,
    taskId: m.taskId,
    attachments: m.attachments,
    status: m.status,
    meta: m.meta,
    ...(byMessage.has(m.id) ? { approvals: byMessage.get(m.id) } : {}),
    createdAt: m.createdAt.toISOString(),
  }));
  return { conversation: c, messages: out };
});

export const DELETE = route<P>("MEMBER", async ({ session, params }) => {
  await db.delete(conversations).where(and(eq(conversations.id, params.id), eq(conversations.workspaceId, session.workspaceId)));
  return { ok: true };
});
