import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, conversations, db, employeeRevisions, employees, members, messages, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { POST as postMessage } from "@/app/api/conversations/[id]/messages/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/settings/route";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function signedIn(role: "OWNER" | "ADMIN" | "MEMBER" = "ADMIN") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `a-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "A", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  const [emp] = await db
    .insert(employees)
    .values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m", autonomyLevel: "QUEUE", toolPermissions: [{ tool: "send_email", enabled: true }, { tool: "mcp:crm", enabled: true }] })
    .returning();
  return { ws: ws!, emp: emp! };
}

const email = { to: ["Ana <ana@client.co>"], cc: [], subject: "Update", body: "Hi", clientId: randomUUID() };
const autonomyReason = "Irreversible action requires approval (autonomy QUEUE).";

async function send(conversationId: string, content: string) {
  const form = new FormData();
  form.set("content", content);
  const req = new NextRequest(`http://localhost:3010/api/conversations/${conversationId}/messages`, { method: "POST", body: form, headers: { "x-real-ip": "203.0.113.7" } });
  const res = await (postMessage as unknown as (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>)(req, { params: Promise.resolve({ id: conversationId }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("Always allow", () => {
  it("approves, adds an allow-list rule for these recipients and client, sets the tool to CLOSE, and records a revision", async () => {
    const { ws, emp } = await signedIn();
    const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_email", title: "Email: Update", reason: autonomyReason, payload: email }).returning();
    const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "approve", alwaysAllow: true }, { id: a!.id });
    expect(r.status).toBe(200);
    expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("APPROVED");
    const [e] = await db.select().from(employees).where(eq(employees.id, emp.id));
    expect(e!.allowList).toEqual([{ tool: "send_email", recipientDomains: [], recipients: ["ana@client.co"], clientIds: [email.clientId], note: "Always allow (approval)" }]);
    expect(e!.toolPermissions).toEqual([{ tool: "send_email", enabled: true, autonomy: "CLOSE" }, { tool: "mcp:crm", enabled: true }]);
    const revs = await db.select().from(employeeRevisions).where(eq(employeeRevisions.employeeId, emp.id));
    expect(revs.map((x) => x.source).sort()).toEqual(["baseline", "person"]);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "employee.allow_list_added")))).length).toBe(1);
    expect(queueModule.q.action).toHaveBeenCalledWith({ kind: "execute_approval", approvalId: a!.id, workspaceId: ws.id });

    // the same rule again is not duplicated
    const [b] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_email", title: "Email again", reason: autonomyReason, payload: email }).returning();
    expect((await callWithParams(decide, "POST", `/api/approvals/${b!.id}/decide`, { decision: "approve", alwaysAllow: true }, { id: b!.id })).status).toBe(200);
    expect((await db.select().from(employees).where(eq(employees.id, emp.id)))[0]!.allowList).toHaveLength(1);
  });

  it("an external MCP tool gets an exact-tool rule; the server-level grant becomes CLOSE", async () => {
    const { ws, emp } = await signedIn();
    const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "mcp__crm__send_message", title: "send_message via crm", reason: autonomyReason, payload: { text: "x" } }).returning();
    expect((await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "approve", alwaysAllow: true }, { id: a!.id })).status).toBe(200);
    const [e] = await db.select().from(employees).where(eq(employees.id, emp.id));
    expect(e!.allowList).toEqual([{ tool: "mcp:crm:send_message", recipientDomains: [], clientIds: [], note: "Always allow (approval)" }]);
    expect(e!.toolPermissions[1]).toEqual({ tool: "mcp:crm", enabled: true, autonomy: "CLOSE" });
  });

  it("is refused for a tainted run, a flagged payload, a push, an edit, and leaves the approval pending", async () => {
    const { ws, emp } = await signedIn();
    const cases = [
      { toolName: "send_email", reason: "This run handled untrusted content (external input, a web page or tool output), so irreversible actions need approval.", payload: email, guardFindings: [] },
      { toolName: "send_email", reason: "Output guard found possible secrets/PII in the payload.", payload: email, guardFindings: [{ rule: "aws_key", severity: "high", excerpt: "AKIA…" }] },
      { toolName: "git_push", reason: autonomyReason, payload: { branch: "agent/x", head: "abc" }, guardFindings: [] },
    ];
    for (const c of cases) {
      const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, title: "x", ...c }).returning();
      const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "approve", alwaysAllow: true }, { id: a!.id });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("always_allow_not_offered");
      expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("PENDING");
    }
    const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_email", title: "x", reason: autonomyReason, payload: email }).returning();
    const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "edit_approve", editedPayload: email, alwaysAllow: true }, { id: a!.id });
    expect(r.json.code).toBe("always_allow_approve_only");
    expect((await db.select().from(employees).where(eq(employees.id, emp.id)))[0]!.allowList).toEqual([]);
  });
});

describe("ya / tidak in chat", () => {
  /** a chat whose last message is the reply that asked for `n` approvals (onLeaf false: someone wrote after it) */
  async function chatWith(ws: { id: string }, emp: { id: string }, n = 1, toolName = "send_email", onLeaf = true) {
    const [c] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const [asked] = await db.insert(messages).values({ conversationId: c!.id, role: "assistant", employeeId: emp.id, content: "Boleh saya kirim?" }).returning();
    let leaf = asked!.id;
    if (!onLeaf) leaf = (await db.insert(messages).values({ conversationId: c!.id, parentId: asked!.id, role: "user", content: "pakai template lama?" }).returning())[0]!.id;
    await db.update(conversations).set({ activeLeafId: leaf }).where(eq(conversations.id, c!.id));
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [a] = await db
        .insert(approvals)
        .values({ workspaceId: ws.id, employeeId: emp.id, conversationId: c!.id, messageId: asked!.id, toolName, title: `Email ${i}`, reason: autonomyReason, payload: email })
        .returning();
      ids.push(a!.id);
    }
    return { c: c!, ids };
  }

  it("'ya' approves the one waiting approval; the reply is kept as handled and is not a turn", async () => {
    const { ws, emp } = await signedIn();
    const { c, ids } = await chatWith(ws, emp);
    const r = await send(c.id, "Ya!");
    expect(r.status).toBe(200);
    expect(r.json.approval).toEqual({ approvalId: ids[0], decision: "approve" });
    expect((await db.select().from(approvals).where(eq(approvals.id, ids[0]!)))[0]).toMatchObject({ status: "APPROVED" });
    const [m] = await db.select().from(messages).where(and(eq(messages.conversationId, c.id), eq(messages.role, "user")));
    expect(m!.handledAt).not.toBeNull();
    expect(m!.meta).toMatchObject({ approvalReply: { approvalId: ids[0], decision: "approve" } });
    expect(queueModule.q.chat).not.toHaveBeenCalled();
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "approval.approved")));
    expect(audit!.details).toMatchObject({ via: "chat" });
  });

  it("'tolak' rejects; two waiting approvals, a longer message, a LIVE release or a member make it a normal message", async () => {
    const { ws, emp } = await signedIn();
    const one = await chatWith(ws, emp);
    expect((await send(one.c.id, "tolak")).json.approval).toEqual({ approvalId: one.ids[0], decision: "reject" });
    expect((await db.select().from(approvals).where(eq(approvals.id, one.ids[0]!)))[0]!.status).toBe("REJECTED");

    const two = await chatWith(ws, emp, 2);
    expect((await send(two.c.id, "ya")).json.approval).toBeUndefined();
    const longer = await chatWith(ws, emp);
    expect((await send(longer.c.id, "ya tapi ganti subjeknya")).json.approval).toBeUndefined();
    const live = await chatWith(ws, emp, 1, "request_release");
    expect((await send(live.c.id, "ya")).json.approval).toBeUndefined();
    // the admin wrote something else after the card: a later "no" answers that, not the approval
    const later = await chatWith(ws, emp, 1, "send_email", false);
    expect((await send(later.c.id, "no")).json.approval).toBeUndefined();
    for (const id of [...two.ids, ...longer.ids, ...live.ids, ...later.ids]) expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.status).toBe("PENDING");
    expect(queueModule.q.chat).toHaveBeenCalledTimes(4);
  });

  it("a member's 'ya' is a normal message", async () => {
    const { ws, emp } = await signedIn("MEMBER");
    const { c, ids } = await chatWith(ws, emp);
    expect((await send(c.id, "ya")).json.approval).toBeUndefined();
    expect((await db.select().from(approvals).where(eq(approvals.id, ids[0]!)))[0]!.status).toBe("PENDING");
  });
});

describe("approval expiry setting", () => {
  it("defaults to 168 hours and an admin can change it (0 = never)", async () => {
    await signedIn();
    expect(((await call(getSettings, "GET", "/api/settings")).json.workspace as { approvalExpiryHours: number }).approvalExpiryHours).toBe(168);
    expect((await call(putSettings, "PUT", "/api/settings", { approvalExpiryHours: 0 })).status).toBe(200);
    expect(((await call(getSettings, "GET", "/api/settings")).json.workspace as { approvalExpiryHours: number }).approvalExpiryHours).toBe(0);
    expect((await call(putSettings, "PUT", "/api/settings", { approvalExpiryHours: 5000 })).status).toBe(400);
  });
});
