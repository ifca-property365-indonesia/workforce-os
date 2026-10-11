import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, auditLog, conversations, db, employees, members, messages, teamMembers, teams, users, workspaces } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { POST as postMessage } from "@/app/api/conversations/[id]/messages/route";
import { PATCH as editMessage } from "@/app/api/conversations/[id]/messages/[messageId]/route";
import { POST as regenerate } from "@/app/api/conversations/[id]/messages/[messageId]/regenerate/route";
import { POST as switchBranch } from "@/app/api/conversations/[id]/branch/route";
import { GET as listApprovals } from "@/app/api/approvals/route";
import { regenJobId } from "@/lib/server/job-ids";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

// the shared queue stand-in predates chat_regenerate: record it here
const chatRegenerate = vi.fn();
Object.assign(queueModule.q, { chatRegenerate });

beforeEach(() => {
  resetBrowser();
  queueModule.q.chat.mockClear();
  queueModule.control.mockClear();
  queueModule.publish.mockClear();
  chatRegenerate.mockClear();
});

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Json = Record<string, unknown>;
interface ThreadJson {
  messages: ChatMessageDTO[];
  activeLeafId: string | null;
  conversation: { id: string; activeLeafId: string | null };
}

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [sari, budi] = await db
    .insert(employees)
    .values([
      { workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" },
      { workspaceId: ws!.id, name: "Budi", role: "Sales", model: "m" },
    ])
    .returning();
  const [team] = await db.insert(teams).values({ workspaceId: ws!.id, name: "Squad", leadId: sari!.id }).returning();
  await db.insert(teamMembers).values([
    { teamId: team!.id, employeeId: sari!.id },
    { teamId: team!.id, employeeId: budi!.id },
  ]);
  return { ws: ws!, sari: sari!, budi: budi!, team: team! };
}

/** Workspace A (signed in as MEMBER) and workspace B (someone else's). */
async function signedIn() {
  const a = await workspace();
  const b = await workspace();
  const email = `t-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: a.ws.id, userId: u!.id, role: "MEMBER" });
  const r = await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  expect(r.status).toBe(200);
  return { a, b };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s));

type Row = typeof messages.$inferSelect;
type NewRow = Omit<typeof messages.$inferInsert, "conversationId">;

/** Insert rows one by one (parents first) and return them by key. */
async function tree(conversationId: string, rows: Record<string, NewRow & { parent?: string }>): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  for (const [k, { parent, ...v }] of Object.entries(rows)) {
    const [row] = await db
      .insert(messages)
      .values({ conversationId, ...v, parentId: parent ? out[parent]!.id : (v.parentId ?? null) })
      .returning();
    out[k] = row!;
  }
  return out;
}

async function setLeaf(conversationId: string, leafId: string | null) {
  await db.update(conversations).set({ activeLeafId: leafId }).where(eq(conversations.id, conversationId));
}

async function leafOf(conversationId: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return c!.activeLeafId;
}

const get = async (id: string) => {
  const r = await callWithParams(getConversation, "GET", `/api/conversations/${id}`, undefined, { id });
  return { status: r.status, json: r.json as unknown as ThreadJson };
};

/** multipart POST like the composer sends */
async function send(conversationId: string, content: string, expectedLeafId?: string | null) {
  const form = new FormData();
  form.set("content", content);
  if (expectedLeafId !== undefined) form.set("expectedLeafId", expectedLeafId ?? "");
  const req = new NextRequest(`http://localhost:3010/api/conversations/${conversationId}/messages`, { method: "POST", body: form, headers: { "x-real-ip": "203.0.113.7" } });
  const res = await (postMessage as unknown as Handler)(req, { params: Promise.resolve({ id: conversationId }) });
  return { status: res.status, json: (await res.json()) as Json & { message: ChatMessageDTO } };
}

const edit = (id: string, messageId: string, body: unknown) => callWithParams(editMessage, "PATCH", `/api/conversations/${id}/messages/${messageId}`, body, { id, messageId });

async function editMultipart(id: string, messageId: string, content: string, expectedLeafId: string) {
  const form = new FormData();
  form.set("content", content);
  form.set("expectedLeafId", expectedLeafId);
  const req = new NextRequest(`http://localhost:3010/api/conversations/${id}/messages/${messageId}`, { method: "PATCH", body: form, headers: { "x-real-ip": "203.0.113.7" } });
  const res = await (editMessage as unknown as Handler)(req, { params: Promise.resolve({ id, messageId }) });
  return { status: res.status, json: (await res.json()) as Json };
}

const regen = (id: string, messageId: string) => callWithParams(regenerate, "POST", `/api/conversations/${id}/messages/${messageId}/regenerate`, {}, { id, messageId });
const branch = (id: string, messageId: string) => callWithParams(switchBranch, "POST", `/api/conversations/${id}/branch`, { messageId }, { id });

describe("GET /api/conversations/[id] (branches)", () => {
  it("returns only the active branch, with each message's place among its versions", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    // u1 → a1 → u2 → a2 / a2b (regenerated);  u1e (edit of u1) → a1e
    const t = await tree(c!.id, {
      u1: { role: "user", content: "Hi", createdAt: at(1) },
      a1: { role: "assistant", content: "Hello", employeeId: a.sari.id, parent: "u1", createdAt: at(2) },
      u2: { role: "user", content: "Invoice?", parent: "a1", createdAt: at(3) },
      a2: { role: "assistant", content: "Sent", employeeId: a.sari.id, parent: "u2", createdAt: at(4) },
      a2b: { role: "assistant", content: "Sent (again)", employeeId: a.sari.id, parent: "u2", createdAt: at(5) },
      u1e: { role: "user", content: "Hi there", createdAt: at(6) },
      a1e: { role: "assistant", content: "Hey", employeeId: a.sari.id, parent: "u1e", createdAt: at(7) },
    });

    await setLeaf(c!.id, t.a1e!.id);
    let r = await get(c!.id);
    expect(r.status).toBe(200);
    expect(r.json.messages.map((m) => m.id)).toEqual([t.u1e!.id, t.a1e!.id]);
    expect(r.json.activeLeafId).toBe(t.a1e!.id);
    expect(r.json.conversation.activeLeafId).toBe(t.a1e!.id);
    expect(r.json.messages[0]!.branch).toEqual({ index: 1, count: 2, siblingIds: [t.u1!.id, t.u1e!.id] });
    expect(r.json.messages[0]!.parentId).toBeNull();
    expect(r.json.messages[1]!.branch).toBeUndefined();
    expect(r.json.messages[1]!.parentId).toBe(t.u1e!.id);

    await setLeaf(c!.id, t.a2!.id);
    r = await get(c!.id);
    expect(r.json.messages.map((m) => m.content)).toEqual(["Hi", "Hello", "Invoice?", "Sent"]);
    expect(r.json.messages[0]!.branch).toEqual({ index: 0, count: 2, siblingIds: [t.u1!.id, t.u1e!.id] });
    expect(r.json.messages[3]!.branch).toEqual({ index: 0, count: 2, siblingIds: [t.a2!.id, t.a2b!.id] });
    expect(r.json.messages[1]!.branch).toBeUndefined();

    // a stored leaf with replies below it (the worker attached them) extends to the newest of them
    await setLeaf(c!.id, t.u2!.id);
    r = await get(c!.id);
    expect(r.json.messages.at(-1)!.id).toBe(t.a2b!.id);
    expect(r.json.activeLeafId).toBe(t.a2b!.id);
  });

  it("without a stored leaf (a thread from before branching) shows every message in createdAt order", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    await tree(c!.id, {
      y: { role: "assistant", content: "second", createdAt: at(2) },
      x: { role: "user", content: "first", createdAt: at(1) },
    });
    const r = await get(c!.id);
    expect(r.json.messages.map((m) => m.content)).toEqual(["first", "second"]);
    expect(r.json.messages.every((m) => m.branch === undefined)).toBe(true);
    expect(r.json.activeLeafId).toBe(r.json.messages[1]!.id);
  });
});

describe("POST /api/conversations/[id]/messages (branches)", () => {
  it("hangs the message below the thread's end and makes it the new end", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const first = await send(c!.id, "one");
    expect(first.status).toBe(200);
    expect(first.json.message.parentId).toBeNull();
    expect(await leafOf(c!.id)).toBe(first.json.message.id);
    // the worker's reply below it, without moving the stored leaf: the next message still follows the reply
    const t = await tree(c!.id, { r: { role: "assistant", content: "ok", employeeId: a.sari.id, parentId: first.json.message.id } });
    const second = await send(c!.id, "two");
    expect(second.json.message.parentId).toBe(t.r!.id);
    expect(await leafOf(c!.id)).toBe(second.json.message.id);
    const [row] = await db.select().from(messages).where(eq(messages.id, second.json.message.id));
    expect(row!.parentId).toBe(t.r!.id);
    expect(queueModule.q.chat).toHaveBeenLastCalledWith(c!.id, second.json.message.id, a.ws.id);
  });

  it("honours expectedLeafId: 409 conversation_changed (nothing stored) when the thread moved on", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const first = await send(c!.id, "one", null);
    expect(first.status).toBe(200);
    const stale = await send(c!.id, "two", null);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("conversation_changed");
    expect(stale.json.activeLeafId).toBe(first.json.message.id);
    expect(typeof stale.json.error).toBe("string");
    expect(await db.select().from(messages).where(eq(messages.conversationId, c!.id))).toHaveLength(1);
    const ok = await send(c!.id, "two", first.json.message.id);
    expect(ok.status).toBe(200);
    expect(ok.json.message.parentId).toBe(first.json.message.id);
  });
});

describe("PATCH /api/conversations/[id]/messages/[messageId] (edit)", () => {
  it("adds a sibling with the new text, moves the end there and answers it", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id, title: "Hi" }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "Hi", createdAt: at(1), handledAt: at(1) },
      a1: { role: "assistant", content: "Hello", parent: "u1", createdAt: at(2) },
      u2: { role: "user", content: "Send invoce", parent: "a1", createdAt: at(3), handledAt: at(3), meta: { untrusted: true }, attachments: [{ name: "a.pdf", size: 3 }] },
      a2: { role: "assistant", content: "Which?", parent: "u2", createdAt: at(4) },
    });
    await setLeaf(c!.id, t.a2!.id);
    const r = await edit(c!.id, t.u2!.id, { content: "Send invoice", expectedLeafId: t.a2!.id });
    expect(r.status).toBe(200);
    const m = r.json.message as ChatMessageDTO;
    expect(m).toMatchObject({ role: "user", content: "Send invoice", parentId: t.a1!.id, attachments: [{ name: "a.pdf", size: 3 }], meta: { untrusted: true } });
    expect(r.json.activeLeafId).toBe(m.id);
    expect(await leafOf(c!.id)).toBe(m.id);
    // the original is untouched and still there (an older version)
    const [orig] = await db.select().from(messages).where(eq(messages.id, t.u2!.id));
    expect(orig!.content).toBe("Send invoce");
    const [row] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(row!.handledAt).toBeNull();
    expect(queueModule.q.chat).toHaveBeenCalledWith(c!.id, m.id, a.ws.id);
    expect(queueModule.control).not.toHaveBeenCalled();
    expect(queueModule.publish).toHaveBeenCalledWith(a.ws.id, expect.objectContaining({ type: "chat.message", conversationId: c!.id }));

    const g = await get(c!.id);
    expect(g.json.messages.map((x) => x.id)).toEqual([t.u1!.id, t.a1!.id, m.id]);
    expect(g.json.messages[2]!.branch).toEqual({ index: 1, count: 2, siblingIds: [t.u2!.id, m.id] });
  });

  it("stops a reply still streaming on the old branch, re-reads @mentions, and follows a first message's title", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id, title: "@Sari hi" }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "@Sari hi", meta: { mentions: [a.sari.id] }, createdAt: new Date(Date.now() - 2000) },
      a1: { role: "assistant", content: "Hel", status: "streaming", employeeId: a.sari.id, parent: "u1", createdAt: new Date(Date.now() - 1000) },
    });
    await setLeaf(c!.id, t.a1!.id);
    const r = await edit(c!.id, t.u1!.id, { content: "@Budi hi", expectedLeafId: t.a1!.id });
    expect(r.status).toBe(200);
    const m = r.json.message as ChatMessageDTO;
    expect(m.parentId).toBeNull();
    expect(m.meta).toEqual({ mentions: [a.budi.id] });
    expect(queueModule.control).toHaveBeenCalledWith({ type: "abort_conversation", conversationId: c!.id });
    // the abort goes out before the new turn is queued
    expect(queueModule.control.mock.invocationCallOrder[0]!).toBeLessThan(queueModule.q.chat.mock.invocationCallOrder[0]!);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, c!.id));
    expect(conv!.title).toBe("@Budi hi");
  });

  it("accepts multipart like the composer, and 409s on a stale expectedLeafId", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "one", createdAt: at(1) },
      a1: { role: "assistant", content: "ok", parent: "u1", createdAt: at(2) },
    });
    await setLeaf(c!.id, t.a1!.id);
    const stale = await edit(c!.id, t.u1!.id, { content: "uno", expectedLeafId: t.u1!.id });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("conversation_changed");
    expect(queueModule.q.chat).not.toHaveBeenCalled();
    expect(await leafOf(c!.id)).toBe(t.a1!.id);

    const r = await editMultipart(c!.id, t.u1!.id, "uno", t.a1!.id);
    expect(r.status).toBe(200);
    expect((r.json.message as ChatMessageDTO).content).toBe("uno");
  });

  it("refuses replies, empty text and messages of another conversation", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const [other] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "one", createdAt: at(1) },
      a1: { role: "assistant", content: "ok", parent: "u1", createdAt: at(2) },
    });
    const notUser = await edit(c!.id, t.a1!.id, { content: "x" });
    expect(notUser.status).toBe(400);
    expect(notUser.json.code).toBe("message_not_editable");
    const empty = await edit(c!.id, t.u1!.id, { content: "   " });
    expect(empty.status).toBe(400);
    expect(empty.json.code).toBe("message_empty");
    expect((await edit(other!.id, t.u1!.id, { content: "x" })).status).toBe(404);
  });
});

describe("POST …/messages/[messageId]/regenerate", () => {
  it("answers the reply's user message again and cuts the thread back to it", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id }).returning();
    // a team turn: the second reply hangs below the first
    const t = await tree(c!.id, {
      u1: { role: "user", content: "Status?", createdAt: at(1), handledAt: at(1) },
      a1: { role: "assistant", content: "Fine", employeeId: a.sari.id, parent: "u1", createdAt: at(2) },
      a2: { role: "assistant", content: "Also fine", employeeId: a.budi.id, parent: "a1", createdAt: at(3) },
    });
    await setLeaf(c!.id, t.a2!.id);
    const r = await regen(c!.id, t.a2!.id);
    expect(r.status).toBe(200);
    expect(r.json.userMessageId).toBe(t.u1!.id);
    expect(chatRegenerate).toHaveBeenCalledWith(c!.id, t.u1!.id, a.ws.id);
    expect(await leafOf(c!.id)).toBe(t.u1!.id);

    // the worker's new reply beside the old one becomes the end of the thread, the old one a version
    const n = await tree(c!.id, { b1: { role: "assistant", content: "Great", employeeId: a.sari.id, parentId: t.u1!.id, createdAt: at(9) } });
    const g = await get(c!.id);
    expect(g.json.messages.map((x) => x.id)).toEqual([t.u1!.id, n.b1!.id]);
    expect(g.json.messages[1]!.branch).toEqual({ index: 1, count: 2, siblingIds: [t.a1!.id, n.b1!.id] });
  });

  it("409s while a reply is being written, and refuses user messages", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "one", createdAt: new Date(Date.now() - 3000) },
      a1: { role: "assistant", content: "ok", parent: "u1", createdAt: new Date(Date.now() - 2000) },
      u2: { role: "user", content: "two", parent: "a1", createdAt: new Date(Date.now() - 1000) },
      a2: { role: "assistant", content: "wri", status: "streaming", parent: "u2", createdAt: new Date() },
    });
    await setLeaf(c!.id, t.a2!.id);
    const busy = await regen(c!.id, t.a1!.id);
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe("reply_in_progress");
    expect(chatRegenerate).not.toHaveBeenCalled();
    expect(await leafOf(c!.id)).toBe(t.a2!.id);
    const user = await regen(c!.id, t.u1!.id);
    expect(user.status).toBe(400);
    expect(user.json.code).toBe("message_not_regenerable");
  });
});

describe("POST /api/conversations/[id]/branch", () => {
  it("switches to a version and walks down to its newest leaf, returning the new branch", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "v1", createdAt: at(1) },
      a1: { role: "assistant", content: "r1", parent: "u1", createdAt: at(2) },
      u2: { role: "user", content: "more", parent: "a1", createdAt: at(3) },
      a2: { role: "assistant", content: "r2", parent: "u2", createdAt: at(4) },
      a2b: { role: "assistant", content: "r2b", parent: "u2", createdAt: at(5) },
      u1e: { role: "user", content: "v2", createdAt: at(6) },
      a1e: { role: "assistant", content: "r1e", parent: "u1e", createdAt: at(7) },
    });
    await setLeaf(c!.id, t.a1e!.id);
    const r = await branch(c!.id, t.u1!.id);
    expect(r.status).toBe(200);
    const view = r.json as unknown as ThreadJson;
    expect(view.messages.map((m) => m.content)).toEqual(["v1", "r1", "more", "r2b"]);
    expect(view.activeLeafId).toBe(t.a2b!.id);
    expect(view.messages[0]!.branch).toEqual({ index: 0, count: 2, siblingIds: [t.u1!.id, t.u1e!.id] });
    expect(await leafOf(c!.id)).toBe(t.a2b!.id);
    // an older reply version
    const older = await branch(c!.id, t.a2!.id);
    expect((older.json as unknown as ThreadJson).messages.map((m) => m.content)).toEqual(["v1", "r1", "more", "r2"]);
    expect(await leafOf(c!.id)).toBe(t.a2!.id);
  });

  it("is scoped to the workspace and the conversation", async () => {
    const { a, b } = await signedIn();
    const [mine] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const [theirs] = await db.insert(conversations).values({ workspaceId: b.ws.id, employeeId: b.sari.id }).returning();
    const t = await tree(theirs!.id, {
      u: { role: "user", content: "secret", createdAt: at(1) },
      r: { role: "assistant", content: "ok", parent: "u", createdAt: at(2) },
    });
    await setLeaf(theirs!.id, t.r!.id);
    expect((await get(theirs!.id)).status).toBe(404);
    expect((await branch(theirs!.id, t.u!.id)).status).toBe(404);
    expect((await edit(theirs!.id, t.u!.id, { content: "x" })).status).toBe(404);
    expect((await regen(theirs!.id, t.r!.id)).status).toBe(404);
    // their message through my conversation
    expect((await branch(mine!.id, t.u!.id)).status).toBe(404);
    expect((await edit(mine!.id, t.u!.id, { content: "x" })).status).toBe(404);
    expect((await regen(mine!.id, t.r!.id)).status).toBe(404);
    expect(await leafOf(theirs!.id)).toBe(t.r!.id);
    expect(await db.select().from(messages).where(eq(messages.conversationId, theirs!.id))).toHaveLength(2);
    expect(chatRegenerate).not.toHaveBeenCalled();
    expect(queueModule.q.chat).not.toHaveBeenCalled();
  });
});

/** A PENDING (or other) approval raised by a chat message. */
async function approvalOn(workspaceId: string, conversationId: string, messageId: string, status: "PENDING" | "APPROVED" = "PENDING") {
  const [a] = await db.insert(approvals).values({ workspaceId, toolName: "send_email", title: `on ${messageId.slice(0, 6)}`, payload: {}, status, conversationId, messageId }).returning();
  return a!;
}
const statusOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

describe("edits and regenerations retract the replies they replace", () => {
  it("an edit expires the pending approvals below the edited message, in the same request", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "Hi", createdAt: at(1) },
      a1: { role: "assistant", content: "Hello", parent: "u1", createdAt: at(2) },
      u2: { role: "user", content: "Send invoice", parent: "a1", createdAt: at(3) },
      a2: { role: "assistant", content: "Sending", parent: "u2", createdAt: at(4) },
      a2b: { role: "assistant", content: "Sending (v2)", parent: "u2", createdAt: at(5) },
      u3: { role: "user", content: "and the PO", parent: "a2", createdAt: at(6) },
      a3: { role: "assistant", content: "PO too", parent: "u3", createdAt: at(7) },
    });
    await setLeaf(c!.id, t.a3!.id);
    const above = await approvalOn(a.ws.id, c!.id, t.a1!.id);
    const below = await approvalOn(a.ws.id, c!.id, t.a2!.id);
    const otherVersion = await approvalOn(a.ws.id, c!.id, t.a2b!.id);
    const deep = await approvalOn(a.ws.id, c!.id, t.a3!.id);
    const decided = await approvalOn(a.ws.id, c!.id, t.a3!.id, "APPROVED");

    const r = await edit(c!.id, t.u2!.id, { content: "Send the invoice", expectedLeafId: t.a3!.id });
    expect(r.status).toBe(200);
    for (const x of [below, otherVersion, deep]) {
      expect(await statusOf(x.id)).toMatchObject({ status: "EXPIRED", feedback: "Superseded by an edited message" });
      expect(queueModule.publish).toHaveBeenCalledWith(a.ws.id, { type: "approval.updated", approvalId: x.id, status: "EXPIRED" });
    }
    // above the edit, and already decided: untouched
    expect((await statusOf(above.id)).status).toBe("PENDING");
    expect((await statusOf(decided.id)).status).toBe("APPROVED");
    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, a.ws.id), eq(auditLog.action, "approval.expired_by_edit")));
    expect(trail.map((x) => x.targetId).sort()).toEqual([below.id, otherVersion.id, deep.id].sort());
    expect(trail[0]!.details).toMatchObject({ via: "edit", conversationId: c!.id });
  });

  it("a refused (stale) edit expires nothing", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "one", createdAt: at(1) },
      a1: { role: "assistant", content: "ok", parent: "u1", createdAt: at(2) },
    });
    await setLeaf(c!.id, t.a1!.id);
    const p = await approvalOn(a.ws.id, c!.id, t.a1!.id);
    expect((await edit(c!.id, t.u1!.id, { content: "uno", expectedLeafId: t.u1!.id })).status).toBe(409);
    expect((await statusOf(p.id)).status).toBe("PENDING");
  });

  it("a regenerate expires the replaced turn's pending approvals (in a team turn, every reply of it)", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id }).returning();
    const t = await tree(c!.id, {
      u0: { role: "user", content: "Earlier", createdAt: at(1) },
      r0: { role: "assistant", content: "Earlier reply", employeeId: a.sari.id, parent: "u0", createdAt: at(2) },
      u1: { role: "user", content: "Status?", parent: "r0", createdAt: at(3) },
      a1: { role: "assistant", content: "Fine", employeeId: a.sari.id, parent: "u1", createdAt: at(4) },
      a2: { role: "assistant", content: "Also fine", employeeId: a.budi.id, parent: "a1", createdAt: at(5) },
    });
    await setLeaf(c!.id, t.a2!.id);
    const earlier = await approvalOn(a.ws.id, c!.id, t.r0!.id);
    const first = await approvalOn(a.ws.id, c!.id, t.a1!.id);
    const second = await approvalOn(a.ws.id, c!.id, t.a2!.id);
    const r = await regen(c!.id, t.a2!.id);
    expect(r.status).toBe(200);
    for (const x of [first, second]) expect(await statusOf(x.id)).toMatchObject({ status: "EXPIRED", feedback: "Superseded by a regenerated reply" });
    expect((await statusOf(earlier.id)).status).toBe("PENDING");
    const trail = await db.select().from(auditLog).where(and(eq(auditLog.action, "approval.expired_by_edit"), inArray(auditLog.targetId, [first.id, second.id])));
    expect(trail).toHaveLength(2);
    expect(trail.every((x) => (x.details as { via: string }).via === "regenerate")).toBe(true);
  });

  it("a version switch expires nothing; the inbox marks approvals from an older version", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const t = await tree(c!.id, {
      u1: { role: "user", content: "v1", createdAt: at(1) },
      a1: { role: "assistant", content: "r1", parent: "u1", createdAt: at(2) },
      u1e: { role: "user", content: "v2", createdAt: at(3) },
      a1e: { role: "assistant", content: "r1e", parent: "u1e", createdAt: at(4) },
    });
    await setLeaf(c!.id, t.a1e!.id);
    const old = await approvalOn(a.ws.id, c!.id, t.a1!.id);
    const current = await approvalOn(a.ws.id, c!.id, t.a1e!.id);
    const [plain] = await db.insert(approvals).values({ workspaceId: a.ws.id, toolName: "send_email", title: "from a task", payload: {} }).returning();
    const inbox = async () => {
      const r = await call(listApprovals, "GET", "/api/approvals?status=PENDING");
      expect(r.status).toBe(200);
      return Object.fromEntries((r.json.approvals as { id: string; olderVersion: boolean }[]).map((x) => [x.id, x.olderVersion]));
    };
    expect(await inbox()).toEqual({ [old.id]: true, [current.id]: false, [plain!.id]: false });

    expect((await branch(c!.id, t.u1!.id)).status).toBe(200);
    expect((await statusOf(old.id)).status).toBe("PENDING");
    expect((await statusOf(current.id)).status).toBe("PENDING");
    expect(await inbox()).toEqual({ [old.id]: false, [current.id]: true, [plain!.id]: false });
  });
});

describe("regenerate job id", () => {
  it("is the same within a 10-second window, so a double submit queues one job", () => {
    const t0 = 1_760_000_000_000;
    expect(regenJobId("m1", t0)).toBe(`regen-m1-${Math.floor(t0 / 10_000)}`);
    expect(regenJobId("m1", t0 + 1)).toBe(regenJobId("m1", t0));
    expect(regenJobId("m1", t0 + 10_000)).not.toBe(regenJobId("m1", t0));
    expect(regenJobId("m2", t0)).not.toBe(regenJobId("m1", t0));
    expect(regenJobId("m1", t0)).not.toContain(":");
  });
});
