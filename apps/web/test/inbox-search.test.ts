import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, clients, db, employees, incidents, members, repositories, tasks, users, workspaces } from "@wfos/db";
import type { Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as getInbox } from "@/app/api/inbox/route";
import { GET as search } from "@/app/api/search/route";
import { POST as incidentAction } from "@/app/api/incidents/[id]/route";
import { likePattern, prefixTsQuery } from "@/lib/server/search";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari Wulandari", role: "Frontend Developer", model: "m" }).returning();
  return { ws: ws!, emp: emp! };
}

async function signedIn(role: Role = "MEMBER") {
  const a = await workspace();
  const b = await workspace();
  const email = `x-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "U", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: a.ws.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { a, b };
}

type Ws = Awaited<ReturnType<typeof workspace>>;
const task = async (w: Ws, over: Partial<typeof tasks.$inferInsert> = {}) =>
  (await db.insert(tasks).values({ workspaceId: w.ws.id, title: "A task", assigneeId: w.emp.id, ...over }).returning())[0]!;
const head = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);

describe("search helpers", () => {
  it("prefixTsQuery: words become prefix terms joined by AND; operators and punctuation never reach to_tsquery", () => {
    expect(prefixTsQuery("Buku tam")).toBe("buku:* & tam:*");
    expect(prefixTsQuery("  !!& | ' ")).toBeNull();
    expect(prefixTsQuery("a:* | b & !c")).toBe("a:* & b:* & c:*");
    expect(prefixTsQuery("kolom Instansi (BE+FE)")).toBe("kolom:* & instansi:* & be:* & fe:*");
    expect(prefixTsQuery("one two three four five six seven")!.split(" & ")).toHaveLength(6);
  });

  it("likePattern: % and _ in the query match literally", () => {
    expect(likePattern(" 50%_off ")).toBe("%50\\%\\_off%");
  });
});

describe("GET /api/inbox", () => {
  it("lists what waits for a person in this workspace only, with counts", async () => {
    const { a, b } = await signedIn("VIEWER");
    const failed = await task(a, { title: "Monthly report", status: "FAILED" });
    const escalated = (await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "time_limit", status: "escalated", taskId: failed.id, employeeId: a.emp.id, summary: "used up" }).returning())[0]!;
    const open = (await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "failed", status: "open", summary: "x" }).returning())[0]!;
    await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "stalled", status: "handling", summary: "a lead is on it" });
    await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "failed", status: "resolved", summary: "done" });
    await db.insert(incidents).values({ workspaceId: b.ws.id, kind: "failed", status: "escalated", summary: "other workspace" });
    const held = await task(a, { title: "Proposed: follow up", status: "QUEUED", phase: "hold" });
    await task(a, { title: "Plain queued", status: "QUEUED" });
    const [paused] = await db.insert(employees).values({ workspaceId: a.ws.id, name: "Bima", role: "Backend", model: "m", status: "PAUSED_BUDGET" }).returning();
    // approvals: one decidable, one of a task still running (decidable once the run ends)
    await db.insert(approvals).values({ workspaceId: a.ws.id, taskId: failed.id, employeeId: a.emp.id, toolName: "send_email", title: "Email", payload: {} });
    const running = await task(a, { status: "RUNNING" });
    await db.insert(approvals).values({ workspaceId: a.ws.id, taskId: running.id, employeeId: a.emp.id, toolName: "bash", title: "pnpm add", payload: {} });

    const r = await call(getInbox, "GET", "/api/inbox");
    expect(r.status).toBe(200);
    const items = r.json.items as { kind: string; id: string }[];
    expect(items.filter((x) => x.kind === "incident").map((x) => x.id).sort()).toEqual([escalated.id, open.id].sort());
    expect(items.filter((x) => x.kind === "held_task").map((x) => x.id)).toEqual([held.id]);
    expect(items.filter((x) => x.kind === "paused_employee").map((x) => x.id)).toEqual([paused!.id]);
    expect(items.find((x) => x.id === escalated.id)).toMatchObject({ incidentKind: "time_limit", status: "escalated", task: { id: failed.id, status: "FAILED" }, employee: { name: "Sari Wulandari" } });
    expect(r.json).toMatchObject({ approvals: 1, approvalsWaiting: 1, counts: { approval: 1, incident: 2, held_task: 1, paused_employee: 1, merge: 0, total: 5 } });
  });

  it("lists finished agent work not merged yet, and failed merges", async () => {
    const { a } = await signedIn("VIEWER");
    const [repo] = await db.insert(repositories).values({ workspaceId: a.ws.id, name: "bukutamu", provider: "github", url: "https://github.com/acme/bukutamu.git", defaultBranch: "main" }).returning();
    const push = async (t: { id: string }) => {
      const h = head();
      await db.insert(approvals).values({ workspaceId: a.ws.id, taskId: t.id, employeeId: a.emp.id, toolName: "git_push", title: "push", status: "EXECUTED", payload: { head: h, branch: `agent/${t.id}` } });
      return h;
    };
    const done = await task(a, { title: "Nav fix", status: "DONE", repositoryId: repo!.id });
    await push(done);
    // still working: its pushed work is not a decision yet
    await push(await task(a, { title: "Still building", status: "RUNNING", repositoryId: repo!.id }));
    // a merge that failed needs a person whatever the task does now
    const conflicted = await task(a, { title: "Bento v2", status: "AWAITING_APPROVAL", repositoryId: repo!.id });
    const h = await push(conflicted);
    await db.insert(approvals).values({
      workspaceId: a.ws.id,
      taskId: conflicted.id,
      toolName: "merge_branch",
      title: "merge",
      status: "FAILED",
      payload: { head: h },
      executionResult: { ok: false, details: { conflicts: ["app/page.tsx"] } },
    });

    const r = await call(getInbox, "GET", "/api/inbox");
    const merges = (r.json.items as { kind: string }[]).filter((x) => x.kind === "merge");
    expect(merges).toHaveLength(2);
    expect(merges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: done.id, state: "unmerged", repository: expect.objectContaining({ name: "bukutamu", defaultBranch: "main" }) }),
        expect.objectContaining({ id: conflicted.id, state: "failed", conflicts: ["app/page.tsx"] }),
      ]),
    );
    expect(r.json).toMatchObject({ counts: { merge: 2 } });
  });
});

describe("POST /api/incidents/[id]", () => {
  it("a member closes an incident that waits for a person, audited; a lead's incident or another workspace's is not found", async () => {
    const { a, b } = await signedIn("MEMBER");
    const mine = (await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "failed", status: "escalated", summary: "x" }).returning())[0]!;
    const leads = (await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "failed", status: "handling", summary: "x" }).returning())[0]!;
    const other = (await db.insert(incidents).values({ workspaceId: b.ws.id, kind: "failed", status: "escalated", summary: "x" }).returning())[0]!;

    const r = await callWithParams(incidentAction, "POST", `/api/incidents/${mine.id}`, { action: "resolve", note: "fixed by hand" }, { id: mine.id });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(incidents).where(eq(incidents.id, mine.id));
    expect(row).toMatchObject({ status: "resolved" });
    expect(row!.resolution).toMatch(/^Closed by .+: fixed by hand$/);
    expect(row!.resolvedAt).toBeInstanceOf(Date);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "incident.resolved"), eq(auditLog.targetId, mine.id)))).toHaveLength(1);

    expect((await callWithParams(incidentAction, "POST", `/api/incidents/${leads.id}`, { action: "resolve" }, { id: leads.id })).status).toBe(404);
    expect((await callWithParams(incidentAction, "POST", `/api/incidents/${other.id}`, { action: "resolve" }, { id: other.id })).status).toBe(404);
    expect((await db.select().from(incidents).where(eq(incidents.id, other.id)))[0]!.status).toBe("escalated");
  });

  it("a viewer cannot close incidents", async () => {
    const { a } = await signedIn("VIEWER");
    const mine = (await db.insert(incidents).values({ workspaceId: a.ws.id, kind: "failed", status: "escalated", summary: "x" }).returning())[0]!;
    expect((await callWithParams(incidentAction, "POST", `/api/incidents/${mine.id}`, { action: "resolve" }, { id: mine.id })).status).toBe(403);
  });
});

describe("GET /api/search", () => {
  it("finds this workspace's tasks by word prefixes of title and brief, and people, clients by name", async () => {
    const { a, b } = await signedIn("VIEWER");
    const t1 = await task(a, { title: "Build: kolom Instansi di Buku Tamu", brief: "Tambahkan field instansi" });
    const t2 = await task(a, { title: "Perbaiki navigasi", brief: "Buku tamu terasa reload penuh" });
    await task(a, { title: "Laporan bulanan", brief: "keuangan" });
    await task(b, { title: "Buku tamu di workspace lain" });
    await db.insert(clients).values({ workspaceId: a.ws.id, name: "PT Grand Outlet Bali" });
    await db.insert(clients).values({ workspaceId: b.ws.id, name: "PT Grand Lain" });

    const r = await call(search, "GET", "/api/search?q=buku%20ta");
    expect(r.status).toBe(200);
    expect((r.json.tasks as { id: string }[]).map((x) => x.id).sort()).toEqual([t1.id, t2.id].sort());

    const people = await call(search, "GET", "/api/search?q=wulan");
    expect(people.json.employees).toEqual([{ id: a.emp.id, name: "Sari Wulandari", role: "Frontend Developer" }]);
    expect((await call(search, "GET", "/api/search?q=frontend")).json.employees).toHaveLength(1);
    expect((await call(search, "GET", "/api/search?q=grand")).json.clients).toEqual([expect.objectContaining({ name: "PT Grand Outlet Bali" })]);
  });

  it("a one-letter or operator-only query returns nothing, and odd characters are safe", async () => {
    await signedIn("VIEWER");
    for (const q of ["b", "&|!", "'); drop table tasks; --", "%_%"]) {
      const r = await call(search, "GET", `/api/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      expect(r.json.tasks).toEqual([]);
    }
  });
});
