import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, employees, members, steps, tasks, teamMembers, teams, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listTeams, POST as createTeam } from "@/app/api/teams/route";
import { DELETE as deleteTeam, PATCH as patchTeam } from "@/app/api/teams/[id]/route";
import { POST as hire } from "@/app/api/employees/route";
import { GET as getEmployee } from "@/app/api/employees/[id]/route";
import { GET as activity } from "@/app/api/employees/[id]/activity/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace(names: string[]) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const rows = await db
    .insert(employees)
    .values(names.map((name) => ({ workspaceId: ws!.id, name, role: name, model: "m" })))
    .returning();
  const e = Object.fromEntries(rows.map((r) => [r.name, r.id])) as Record<string, string>;
  return { ws: ws!, e };
}

/** a person signed in to `wsId` with `role` */
async function signIn(wsId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" = "ADMIN") {
  const email = `d-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: wsId, userId: u!.id, role });
  resetBrowser();
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return u!;
}

const m = (employeeId: string, role: "member" | "subagent" = "member") => ({ employeeId, role });

describe("division structure", () => {
  it("creates a division with a head, a code lead and subagents, and lists it with roles", async () => {
    const { ws, e } = await workspace(["Pratiwi", "Arif", "Citra", "Kirana"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", {
      name: "Delivery",
      key: "delivery",
      leadId: e.Pratiwi,
      codeLeadId: e.Arif,
      members: [m(e.Pratiwi!), m(e.Arif!), m(e.Kirana!), m(e.Citra!, "subagent")],
      sop: { en: "Ship", id: "Kirim" },
      color: "#4f7cff",
      maxParallel: 2,
    });
    expect(r.status).toBe(200);
    const list = await call(listTeams, "GET", "/api/teams");
    const d = (list.json.teams as { key: string; codeLeadId: string; members: { employeeId: string; role: string }[]; workload: unknown; maxParallel: number }[])[0]!;
    expect(d).toMatchObject({ key: "delivery", codeLeadId: e.Arif, maxParallel: 2, workload: { running: 0, queued: 0 } });
    expect(Object.fromEntries(d.members.map((x) => [x.employeeId, x.role]))).toEqual({ [e.Pratiwi!]: "member", [e.Arif!]: "member", [e.Kirana!]: "member", [e.Citra!]: "subagent" });
  });

  it.each([
    ["a head who is not a member", (e: Record<string, string>) => ({ leadId: e.A, members: [m(e.B!)] }), "division_head_not_member"],
    ["a head who is a subagent", (e: Record<string, string>) => ({ leadId: e.A, codeLeadId: e.B, members: [m(e.A!, "subagent"), m(e.B!)] }), "division_head_not_member"],
    ["a code lead who is a subagent", (e: Record<string, string>) => ({ leadId: e.A, codeLeadId: e.B, members: [m(e.A!), m(e.B!, "subagent")] }), "division_code_lead_not_member"],
    ["the head as code lead", (e: Record<string, string>) => ({ leadId: e.A, codeLeadId: e.A, members: [m(e.A!)] }), "division_head_is_code_lead"],
    ["subagents without a code lead", (e: Record<string, string>) => ({ leadId: e.A, members: [m(e.A!), m(e.B!, "subagent")] }), "division_subagents_need_code_lead"],
    ["the same person twice", (e: Record<string, string>) => ({ leadId: null, members: [m(e.A!), m(e.A!)] }), "division_duplicate_member"],
  ])("refuses %s with a translated 400", async (_label, body, code) => {
    const { ws, e } = await workspace(["A", "B"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "X", ...body(e) });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(code);
    expect(typeof r.json.error).toBe("string");
    expect(await db.select().from(teams).where(eq(teams.workspaceId, ws.id))).toEqual([]);
  });

  it("a partial PATCH is checked against the whole stored structure", async () => {
    const { ws, e } = await workspace(["A", "B", "C"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "D", leadId: e.A, codeLeadId: e.B, members: [m(e.A!), m(e.B!), m(e.C!, "subagent")] });
    const id = (r.json.team as { id: string }).id;
    // dropping the code lead would strand the subagent
    const bad = await callWithParams(patchTeam, "PATCH", `/api/teams/${id}`, { codeLeadId: null }, { id });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("division_subagents_need_code_lead");
    const ok = await callWithParams(patchTeam, "PATCH", `/api/teams/${id}`, { maxParallel: 3 }, { id });
    expect(ok.status).toBe(200);
    expect((await db.select().from(teamMembers).where(eq(teamMembers.teamId, id))).length).toBe(3);
  });

  it("refuses an employee of another workspace", async () => {
    const a = await workspace(["A"]);
    const b = await workspace(["Stranger"]);
    await signIn(a.ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "X", leadId: a.e.A, members: [m(a.e.A!), m(b.e.Stranger!)] });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("unknown_employee");
    expect(await db.select().from(teamMembers).where(eq(teamMembers.employeeId, b.e.Stranger!))).toEqual([]);
  });
});

describe("one division per employee", () => {
  it("409 names the person and their division; move: true moves them and clears their old post", async () => {
    const { ws, e } = await workspace(["Hendra", "Putri", "Wulan"]);
    const user = await signIn(ws.id);
    const support = await call(createTeam, "POST", "/api/teams", { name: "Support", leadId: e.Hendra, members: [m(e.Hendra!), m(e.Putri!)] });
    const supportId = (support.json.team as { id: string }).id;
    const finance = await call(createTeam, "POST", "/api/teams", { name: "Finance", leadId: e.Wulan, members: [m(e.Wulan!)] });
    const financeId = (finance.json.team as { id: string }).id;

    const body = { members: [m(e.Wulan!), m(e.Hendra!)] };
    const r = await callWithParams(patchTeam, "PATCH", `/api/teams/${financeId}`, body, { id: financeId });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "employee_in_other_division", employee: "Hendra", division: "Support" });
    expect(String(r.json.error)).toContain("Hendra");
    expect(String(r.json.error)).toContain("Support");

    const moved = await callWithParams(patchTeam, "PATCH", `/api/teams/${financeId}`, { ...body, move: true }, { id: financeId });
    expect(moved.status).toBe(200);
    expect((await db.select().from(teamMembers).where(eq(teamMembers.employeeId, e.Hendra!))).map((x) => x.teamId)).toEqual([financeId]);
    // Hendra was Support's head: Support has none now
    const [s] = await db.select().from(teams).where(eq(teams.id, supportId));
    expect(s!.leadId).toBeNull();
    const out = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "division.members_moved_out")));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ targetId: supportId, actorUserId: user.id });
  });

  it("a new division cannot take someone who is already elsewhere either", async () => {
    const { ws, e } = await workspace(["A"]);
    await signIn(ws.id);
    await call(createTeam, "POST", "/api/teams", { name: "One", leadId: e.A, members: [m(e.A!)] });
    const r = await call(createTeam, "POST", "/api/teams", { name: "Two", leadId: e.A, members: [m(e.A!)] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("employee_in_other_division");
    expect((await db.select().from(teams).where(eq(teams.workspaceId, ws.id))).map((t) => t.name)).toEqual(["One"]);
  });

  it("never moves a code lead away from subagents who still need them", async () => {
    const { ws, e } = await workspace(["Pm", "Tl", "Fe", "Other"]);
    await signIn(ws.id);
    await call(createTeam, "POST", "/api/teams", { name: "Delivery", leadId: e.Pm, codeLeadId: e.Tl, members: [m(e.Pm!), m(e.Tl!), m(e.Fe!, "subagent")] });
    const r = await call(createTeam, "POST", "/api/teams", { name: "Ops", leadId: e.Other, members: [m(e.Other!), m(e.Tl!)], move: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "code_lead_has_subagents", employee: "Tl", division: "Delivery" });
  });
});

describe("division keys, audit and roles", () => {
  it("a key is unique per workspace (409), and free in another workspace", async () => {
    const a = await workspace(["A", "B"]);
    await signIn(a.ws.id);
    expect((await call(createTeam, "POST", "/api/teams", { name: "Support", key: "support", leadId: null })).status).toBe(200);
    const dup = await call(createTeam, "POST", "/api/teams", { name: "Help desk", key: "support", leadId: null });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ code: "division_key_taken", key: "support" });
    const b = await workspace(["C"]);
    await signIn(b.ws.id);
    expect((await call(createTeam, "POST", "/api/teams", { name: "Support", key: "support", leadId: null })).status).toBe(200);
  });

  it("writes the acting user into the audit log for create, structure changes and delete", async () => {
    const { ws, e } = await workspace(["A", "B", "C"]);
    const user = await signIn(ws.id, "OWNER");
    const r = await call(createTeam, "POST", "/api/teams", { name: "D", leadId: e.A, members: [m(e.A!)] });
    const id = (r.json.team as { id: string }).id;
    await callWithParams(patchTeam, "PATCH", `/api/teams/${id}`, { codeLeadId: e.B, members: [m(e.A!), m(e.B!), m(e.C!, "subagent")] }, { id });
    await callWithParams(patchTeam, "PATCH", `/api/teams/${id}`, { leadId: e.B, codeLeadId: null, members: [m(e.A!), m(e.B!)] }, { id });
    expect((await callWithParams(deleteTeam, "DELETE", `/api/teams/${id}`, undefined, { id })).status).toBe(200);
    const log = await db.select().from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.targetId, id)));
    expect(log.map((x) => x.action).sort()).toEqual(["division.created", "division.deleted", "division.updated", "division.updated"]);
    expect(log.every((x) => x.actorUserId === user.id)).toBe(true);
    const updates = log.filter((x) => x.action === "division.updated").map((x) => x.details as Record<string, unknown>);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codeLead: { from: null, to: e.B }, added: [m(e.B!), m(e.C!, "subagent")] }),
        expect.objectContaining({ head: { from: e.A, to: e.B }, codeLead: { from: e.B, to: null }, removed: [e.C] }),
      ]),
    );
  });

  it.each(["MEMBER", "VIEWER"] as const)("a %s cannot change the structure", async (role) => {
    const { ws, e } = await workspace(["A"]);
    const [team] = await db.insert(teams).values({ workspaceId: ws.id, name: "D", leadId: e.A }).returning();
    await signIn(ws.id, role);
    expect((await call(createTeam, "POST", "/api/teams", { name: "X", leadId: null })).status).toBe(403);
    expect((await callWithParams(patchTeam, "PATCH", `/api/teams/${team!.id}`, { name: "Y" }, { id: team!.id })).status).toBe(403);
    expect((await callWithParams(deleteTeam, "DELETE", `/api/teams/${team!.id}`, undefined, { id: team!.id })).status).toBe(403);
    // reading the org chart is fine
    expect((await call(listTeams, "GET", "/api/teams")).status).toBe(200);
    expect((await db.select().from(teams).where(eq(teams.id, team!.id)))[0]!.name).toBe("D");
  });

  it("another workspace's division is not found", async () => {
    const a = await workspace(["A"]);
    const b = await workspace(["B"]);
    const [theirs] = await db.insert(teams).values({ workspaceId: b.ws.id, name: "Theirs" }).returning();
    await signIn(a.ws.id);
    const r = await callWithParams(patchTeam, "PATCH", `/api/teams/${theirs!.id}`, { name: "Mine" }, { id: theirs!.id });
    expect(r.status).toBe(404);
    expect((await callWithParams(deleteTeam, "DELETE", `/api/teams/${theirs!.id}`, undefined, { id: theirs!.id })).status).toBe(404);
    expect((await db.select().from(teams).where(eq(teams.id, theirs!.id)))[0]!.name).toBe("Theirs");
  });
});

describe("workload, credits and subagent work", () => {
  it("counts tasks and 7-day credits per member, a subagent's steps for the subagent", async () => {
    const { ws, e } = await workspace(["Pm", "Tl", "Fe"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "Delivery", leadId: e.Pm, codeLeadId: e.Tl, members: [m(e.Pm!), m(e.Tl!), m(e.Fe!, "subagent")] });
    const id = (r.json.team as { id: string }).id;
    const [run] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Build", assigneeId: e.Tl, status: "RUNNING" }).returning();
    await db.insert(tasks).values({ workspaceId: ws.id, title: "Next", teamId: id, status: "QUEUED" });
    await db.insert(steps).values([
      { workspaceId: ws.id, taskId: run!.id, employeeId: e.Tl, kind: "llm", name: "x", credits: 5 },
      // the frontend subagent acting inside the code lead's run
      { workspaceId: ws.id, taskId: run!.id, employeeId: e.Tl, actorEmployeeId: e.Fe, kind: "tool", name: "Edit", credits: 3 },
      { workspaceId: ws.id, employeeId: e.Pm, kind: "llm", name: "old", credits: 100, createdAt: new Date(Date.now() - 9 * 86_400_000) },
    ]);
    const list = await call(listTeams, "GET", "/api/teams");
    const d = (list.json.teams as { workload: unknown; credits7d: number; members: { employeeId: string; credits7d: number }[] }[])[0]!;
    expect(d.workload).toEqual({ running: 1, queued: 1 });
    expect(d.credits7d).toBe(8);
    expect(Object.fromEntries(d.members.map((x) => [x.employeeId, x.credits7d]))).toEqual({ [e.Pm!]: 0, [e.Tl!]: 5, [e.Fe!]: 3 });

    // the subagent's profile: division role, 7-day cost and the step marked as done in the code lead's run
    const fe = await callWithParams(getEmployee, "GET", `/api/employees/${e.Fe}`, undefined, { id: e.Fe! });
    expect(fe.json.employee).toMatchObject({ credits7d: 3, division: { id, name: "Delivery", role: "subagent" } });
    const tl = await callWithParams(getEmployee, "GET", `/api/employees/${e.Tl}`, undefined, { id: e.Tl! });
    expect((tl.json.employee as { division: { role: string } }).division.role).toBe("code_lead");
    // each step counts once: the subagent's 3 credits are not the code lead's too
    expect(tl.json.employee).toMatchObject({ credits7d: 5 });
    const act = await callWithParams(activity, "GET", `/api/employees/${e.Fe}/activity`, undefined, { id: e.Fe! });
    expect(act.json.recent).toMatchObject([{ name: "Edit", asSubagentOf: { id: e.Tl, name: "Tl" } }]);
    const sumDaily = (j: Record<string, unknown>) => (j.daily as { credits: number }[]).reduce((a, d) => a + d.credits, 0);
    expect(sumDaily(act.json)).toBe(3);
    const tlAct = await callWithParams(activity, "GET", `/api/employees/${e.Tl}/activity`, undefined, { id: e.Tl! });
    // the code lead's history still lists the subagent's step in its run, but its daily cost is its own 5
    expect((tlAct.json.recent as unknown[]).length).toBe(2);
    expect(sumDaily(tlAct.json)).toBe(5);
  });
});

describe("hiring into a division", () => {
  it("creates the employee and adds them with their role", async () => {
    const { ws, e } = await workspace(["Pm", "Tl"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "Delivery", leadId: e.Pm, codeLeadId: e.Tl, members: [m(e.Pm!), m(e.Tl!)] });
    const id = (r.json.team as { id: string }).id;
    const h = await call(hire, "POST", "/api/employees", { name: "Bima", role: "Backend", specialty: "APIs and Postgres", division: { teamId: id, role: "subagent" } });
    expect(h.status).toBe(200);
    const bima = h.json.employee as { id: string; specialty: string };
    expect(bima.specialty).toBe("APIs and Postgres");
    expect(await db.select().from(teamMembers).where(eq(teamMembers.employeeId, bima.id))).toMatchObject([{ teamId: id, role: "subagent" }]);
  });

  it("refuses a subagent for a division without a code lead, and hires nobody", async () => {
    const { ws, e } = await workspace(["Hendra"]);
    await signIn(ws.id);
    const r = await call(createTeam, "POST", "/api/teams", { name: "Support", leadId: e.Hendra, members: [m(e.Hendra!)] });
    const id = (r.json.team as { id: string }).id;
    const h = await call(hire, "POST", "/api/employees", { name: "Putri", role: "Support", division: { teamId: id, role: "subagent" } });
    expect(h.status).toBe(400);
    expect(h.json.code).toBe("division_subagents_need_code_lead");
    expect((await db.select().from(employees).where(eq(employees.workspaceId, ws.id))).map((x) => x.name)).toEqual(["Hendra"]);
  });
});

describe("receipts for division work", () => {
  it("names subagent runs, code tools, handoffs and ordered subtasks", async () => {
    const { describeReceipt } = await import("@/lib/step-labels");
    const r = (kind: string, name: string, input: unknown = null, status = "ok") => describeReceipt({ kind, name, input, output: null, status });
    expect(r("system", "subagent_started", { description: "Build the form" })).toEqual({ key: "subagent_started", values: { task: "Build the form" } });
    expect(r("system", "subagent_finished", null, "error").key).toBe("subagent_failed");
    expect(r("tool", "Edit", { file_path: "/workspace/src/app/page.tsx" })).toMatchObject({ key: "code_edit", values: { file: "page.tsx" } });
    expect(r("tool", "Bash", { command: "pnpm test" })).toMatchObject({ key: "code_bash", values: { command: "pnpm test" } });
    expect(r("tool", "handoff_to_division", { divisionKey: "finance", title: "Invoice milestone 1" })).toMatchObject({ key: "handoff_to_division", values: { division: "finance", title: "Invoice milestone 1" } });
    for (const name of ["dependencies_done", "subtask_blocked", "waiting_for_prd_decision"]) expect(r("system", name).key).toBe(name);
    expect(r("budget", "division_budget_cap").key).toBe("division_budget_cap");
  });
});

describe("approval tiers on the timeline", () => {
  it("a lead_review step reads as approved / denied / passed on by the reviewer (AI), in English and Indonesian", async () => {
    const { describeReceipt, describeStep } = await import("@/lib/step-labels");
    const { readFileSync } = await import("node:fs");
    const cat = (lang: string, ns: string) => JSON.parse(readFileSync(`messages/${lang}/${ns}.json`, "utf8"));
    const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
    const step = (decision: string) => ({
      kind: "approval",
      name: "lead_review",
      status: decision === "allow" ? "ok" : decision === "deny" ? "denied" : "escalated",
      input: { command: "pnpm add zod", by: "self" },
      output: { decision, reason: "r", reviewerName: "Pratiwi", reviewerId: "x" },
    });
    expect(describeStep(step("allow"))).toEqual({ type: "lead_review", decision: "allow", reviewer: "Pratiwi", command: "pnpm add zod" });
    expect(describeReceipt(step("deny"))).toEqual({ key: "lead_review_deny", values: { reviewer: "Pratiwi", command: "pnpm add zod" } });
    const id = cat("id", "inspector").stepName.leadReview;
    const en = cat("en", "inspector").stepName.leadReview;
    expect(fill(id.allow, { reviewer: "Pratiwi" })).toBe("Disetujui oleh Pratiwi (AI)");
    expect(fill(id.deny, { reviewer: "Pratiwi" })).toBe("Ditolak oleh Pratiwi (AI)");
    expect(fill(en.allow, { reviewer: "Pratiwi" })).toBe("Approved by Pratiwi (AI)");
    expect(fill(en.deny, { reviewer: "Pratiwi" })).toBe("Denied by Pratiwi (AI)");
    for (const lang of ["en", "id"]) {
      const receipts = cat(lang, "employees").activity.receipt;
      for (const d of ["allow", "deny", "escalate"]) expect(receipts[`lead_review_${d}`]).toContain("{reviewer}");
      for (const k of ["finish_review", "team_review_accepted", "team_review_failed", "team_review_no_verdict"]) expect(receipts[k]).toBeTruthy();
    }
  });
});

