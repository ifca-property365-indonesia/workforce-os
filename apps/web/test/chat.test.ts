import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, conversations, db, employees, members, messages, teamMembers, teams, users, workspaces } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { POST as postMessage } from "@/app/api/conversations/[id]/messages/route";
import { GET as listTeams, POST as createTeam } from "@/app/api/teams/route";
import { PATCH as patchTeam } from "@/app/api/teams/[id]/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [sari, budi, rina] = await db
    .insert(employees)
    .values([
      { workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" },
      { workspaceId: ws!.id, name: "Budi Santoso", role: "Sales", model: "m" },
      { workspaceId: ws!.id, name: "Rina", role: "Support", model: "m" },
    ])
    .returning();
  const [team] = await db.insert(teams).values({ workspaceId: ws!.id, name: "Squad", leadId: sari!.id }).returning();
  await db.insert(teamMembers).values([
    { teamId: team!.id, employeeId: sari!.id },
    { teamId: team!.id, employeeId: budi!.id },
  ]);
  return { ws: ws!, sari: sari!, budi: budi!, rina: rina!, team: team! };
}

/** Workspace A (signed in as ADMIN) and workspace B (someone else's). */
async function signedIn() {
  const a = await workspace();
  const b = await workspace();
  const email = `t-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: a.ws.id, userId: u!.id, role: "ADMIN" });
  const r = await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  expect(r.status).toBe(200);
  return { a, b, userId: u!.id };
}

/** The messages route takes multipart form data. */
async function send(conversationId: string, content: string) {
  const form = new FormData();
  form.set("content", content);
  const req = new NextRequest(`http://localhost:3010/api/conversations/${conversationId}/messages`, { method: "POST", body: form, headers: { "x-real-ip": "203.0.113.7" } });
  const res = await (postMessage as unknown as (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>)(req, { params: Promise.resolve({ id: conversationId }) });
  return { status: res.status, json: (await res.json()) as { message: ChatMessageDTO } };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s));

describe("GET /api/conversations/[id]", () => {
  it("attaches each approval to the assistant message that raised it, oldest first, from this workspace only", async () => {
    const { a, b } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const [user, first, second] = await db
      .insert(messages)
      .values([
        { conversationId: c!.id, role: "user", content: "Send the invoice", createdAt: at(0) },
        { conversationId: c!.id, role: "assistant", content: "Drafted", employeeId: a.sari.id, createdAt: at(1) },
        { conversationId: c!.id, role: "assistant", content: "And the email", employeeId: a.sari.id, createdAt: at(2) },
      ])
      .returning();
    const base = { workspaceId: a.ws.id, employeeId: a.sari.id, conversationId: c!.id, payload: { to: ["x@y.z"] } };
    const [late, early, other] = await db
      .insert(approvals)
      .values([
        {
          ...base,
          toolName: "send_email",
          title: "Late",
          messageId: first!.id,
          createdAt: at(30),
          // one well-formed finding, plus junk the mapping must drop
          guardFindings: [{ rule: "secret_leak", severity: "high", excerpt: "sk-…" }, { rule: "x", severity: "extreme" }, "nope", null],
        },
        { ...base, toolName: "send_invoice", title: "Early", messageId: first!.id, createdAt: at(10), status: "EXECUTED", executionResult: { summary: "sent" } },
        { ...base, toolName: "send_email", title: "Other", messageId: second!.id, createdAt: at(20) },
      ])
      .returning();
    // a stray row of another workspace pointing at this message must never show up here
    await db.insert(approvals).values({ workspaceId: b.ws.id, toolName: "send_email", title: "Foreign", payload: {}, messageId: first!.id });

    const r = await callWithParams(getConversation, "GET", `/api/conversations/${c!.id}`, undefined, { id: c!.id });
    expect(r.status).toBe(200);
    const ms = r.json.messages as ChatMessageDTO[];
    expect(ms.map((m) => m.id)).toEqual([user!.id, first!.id, second!.id]);
    expect(ms[0]!.approvals).toBeUndefined();
    expect(ms[1]!.approvals!.map((x) => x.id)).toEqual([early!.id, late!.id]);
    expect(ms[1]!.approvals![0]).toMatchObject({ toolName: "send_invoice", title: "Early", status: "EXECUTED", executionResult: { summary: "sent" }, payload: { to: ["x@y.z"] }, editedPayload: null, feedback: null, decidedAt: null });
    expect(typeof ms[1]!.approvals![0]!.createdAt).toBe("string");
    expect(ms[1]!.approvals![0]!.guardFindings).toEqual([]);
    expect(ms[1]!.approvals![1]!.guardFindings).toEqual([{ rule: "secret_leak", severity: "high", excerpt: "sk-…" }]);
    expect(ms[2]!.approvals![0]!.guardFindings).toEqual([]);
    expect(ms[2]!.approvals!.map((x) => x.id)).toEqual([other!.id]);
  });

  it("404s for another workspace's conversation", async () => {
    const { b } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: b.ws.id, employeeId: b.sari.id }).returning();
    const r = await callWithParams(getConversation, "GET", `/api/conversations/${c!.id}`, undefined, { id: c!.id });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/conversations/[id]/messages", () => {
  it("stores @mentions of team members (longest name first, team order) and @semua, leaving the content as typed", async () => {
    const { a, b } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id }).returning();
    // Rina works here but is not on the team; the other workspace has its own "Rina" and "Sari"
    const content = "@budi santoso and @Rina, also @SARI and @semua — mail budi@example.com";
    const r = await send(c!.id, content);
    expect(r.status).toBe(200);
    expect(r.json.message.meta).toEqual({ mentions: [a.sari.id, a.budi.id], mentionAll: true });
    const [row] = await db.select().from(messages).where(eq(messages.id, r.json.message.id));
    expect(row!.content).toBe(content);
    expect(row!.meta).toEqual({ mentions: [a.sari.id, a.budi.id], mentionAll: true });
    expect(row!.meta.mentions).not.toContain(a.rina.id);
    expect(row!.meta.mentions).not.toContain(b.sari.id);
  });

  it("answers a non-multipart body with a translated 400, not a 500", async () => {
    const { a } = await signedIn();
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const req = new NextRequest(`http://localhost:3010/api/conversations/${c!.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hi" }),
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
    });
    const res = await (postMessage as unknown as (r: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(req, { params: Promise.resolve({ id: c!.id }) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe("invalid_form");
    expect(json.error).toMatch(/form/i);
    expect(await db.select().from(messages).where(eq(messages.conversationId, c!.id))).toEqual([]);
  });

  it("ignores mentions of non-members and in one-to-one chats", async () => {
    const { a } = await signedIn();
    const [teamChat] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id }).returning();
    const only = await send(teamChat!.id, "@Rina can you help?");
    expect(only.status).toBe(200);
    expect(only.json.message.meta).toEqual({});
    const [direct] = await db.insert(conversations).values({ workspaceId: a.ws.id, employeeId: a.sari.id }).returning();
    const dm = await send(direct!.id, "@Sari hi");
    expect(dm.json.message.meta).toEqual({});
  });

  it("counts the Lead even when they are missing from team_members, but not archived members", async () => {
    const { a } = await signedIn();
    await db.delete(teamMembers).where(eq(teamMembers.employeeId, a.sari.id));
    await db.update(employees).set({ status: "ARCHIVED" }).where(eq(employees.id, a.budi.id));
    const [c] = await db.insert(conversations).values({ workspaceId: a.ws.id, teamId: a.team.id }).returning();
    const r = await send(c!.id, "@Sari and @Budi Santoso");
    expect(r.json.message.meta).toEqual({ mentions: [a.sari.id] });
  });
});

describe("teams responderMode", () => {
  it("defaults to lead, is accepted on create and PATCH, returned by GET, and validated", async () => {
    const { a } = await signedIn();
    const created = await call(createTeam, "POST", "/api/teams", { name: "Auto squad", leadId: a.sari.id, responderMode: "mentions" });
    expect(created.status).toBe(200);
    expect((created.json.team as { responderMode: string }).responderMode).toBe("mentions");
    const plain = await call(createTeam, "POST", "/api/teams", { name: "Plain", leadId: null });
    expect((plain.json.team as { responderMode: string }).responderMode).toBe("lead");

    const ok = await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { responderMode: "auto" }, { id: a.team.id });
    expect(ok.status).toBe(200);
    expect((ok.json.team as { responderMode: string }).responderMode).toBe("auto");
    const [row] = await db.select().from(teams).where(eq(teams.id, a.team.id));
    expect(row).toMatchObject({ responderMode: "auto", leadId: a.sari.id, name: "Squad" });

    // a PATCH without the field leaves it alone (no Zod default overwrite)
    await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { name: "Renamed" }, { id: a.team.id });
    const [renamed] = await db.select().from(teams).where(eq(teams.id, a.team.id));
    expect(renamed!.responderMode).toBe("auto");

    const bad = await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { responderMode: "loudest" }, { id: a.team.id });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");

    const list = await call(listTeams, "GET", "/api/teams");
    const mine = (list.json.teams as { id: string; responderMode: string }[]).find((t) => t.id === a.team.id);
    expect(mine!.responderMode).toBe("auto");
  });

  it("PATCH of another workspace's team is a 404 and changes nothing", async () => {
    const { b } = await signedIn();
    const r = await callWithParams(patchTeam, "PATCH", `/api/teams/${b.team.id}`, { responderMode: "everyone" }, { id: b.team.id });
    expect(r.status).toBe(404);
    const [row] = await db.select().from(teams).where(eq(teams.id, b.team.id));
    expect(row!.responderMode).toBe("lead");
  });
});
