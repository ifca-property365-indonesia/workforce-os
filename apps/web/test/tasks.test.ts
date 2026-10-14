import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, employees, members, repositories, steps, TASK_INPUT_ERROR_CODES, tasks, teamMembers, teams, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { POST as taskAction } from "@/app/api/tasks/[id]/actions/route";
import { POST as createTeam } from "@/app/api/teams/route";
import { PATCH as patchTeam } from "@/app/api/teams/[id]/route";
import { GET as activity } from "@/app/api/employees/[id]/activity/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const [team] = await db.insert(teams).values({ workspaceId: ws!.id, name: "Squad", leadId: emp!.id }).returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: ws!.id, name: `r-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/x/y.git" }).returning();
  return { ws: ws!, emp: emp!, team: team!, repo: repo! };
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

describe("every task input error has a translated message", () => {
  it.each(TASK_INPUT_ERROR_CODES)("errors.%s exists in en and id", (code) => {
    for (const locale of ["en", "id"]) {
      const catalog = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "messages", locale, "errors.json"), "utf8")) as Record<string, string>;
      expect(catalog[code], `${locale}/errors.json ${code}`).toBeTruthy();
    }
  });
});

describe("POST /api/tasks", () => {
  it("creates a board task with the caller as creator", async () => {
    const { a, userId } = await signedIn();
    const r = await call(createTaskRoute, "POST", "/api/tasks", { title: "Report", brief: "Do it", assigneeId: a.emp.id, repositoryId: a.repo.id, start: false });
    expect(r.status).toBe(200);
    const task = r.json.task as { id: string };
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ workspaceId: a.ws.id, assigneeId: a.emp.id, repositoryId: a.repo.id, source: "board", status: "QUEUED", phase: "hold", createdBy: userId, dryRun: false });
  });

  it.each([
    ["assigneeId", "unknown_employee"],
    ["teamId", "unknown_team"],
    ["repositoryId", "repository_not_found"],
  ] as const)("refuses another workspace's %s with 400 %s", async (field, code) => {
    const { a, b } = await signedIn();
    const foreign = { assigneeId: b.emp.id, teamId: b.team.id, repositoryId: b.repo.id }[field];
    const r = await call(createTaskRoute, "POST", "/api/tasks", { title: "Sneaky", assigneeId: a.emp.id, [field]: foreign });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(code);
    expect(typeof r.json.error).toBe("string");
    expect((await db.select().from(tasks).where(eq(tasks.workspaceId, a.ws.id))).length).toBe(0);
  });

  it("keeps the board's rules: an assignee or team is required, and a team needs a Lead", async () => {
    const { a } = await signedIn();
    const [leaderless] = await db.insert(teams).values({ workspaceId: a.ws.id, name: "No lead", leadId: null }).returning();
    const none = await call(createTaskRoute, "POST", "/api/tasks", { title: "x" });
    expect(none.status).toBe(400);
    expect(none.json.code).toBe("task_needs_assignee");
    const noLead = await call(createTaskRoute, "POST", "/api/tasks", { title: "x", teamId: leaderless!.id });
    expect(noLead.status).toBe(400);
    expect(noLead.json.code).toBe("team_has_no_lead");
    const team = await call(createTaskRoute, "POST", "/api/tasks", { title: "x", teamId: a.team.id });
    expect(team.status).toBe(200);
  });

  it("a rerun of finished work copies the task through the same helper", async () => {
    const { a, userId } = await signedIn();
    const [done] = await db.insert(tasks).values({ workspaceId: a.ws.id, title: "Done", brief: "b", assigneeId: a.emp.id, status: "DONE" }).returning();
    const r = await callWithParams(taskAction, "POST", `/api/tasks/${done!.id}/actions`, { action: "dry_run" }, { id: done!.id });
    expect(r.status).toBe(200);
    const [copy] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(copy).toMatchObject({ title: "[DRY RUN] Done", brief: "b", assigneeId: a.emp.id, dryRun: true, source: "board", status: "QUEUED", createdBy: userId });
  });
});

describe("teams (divisions)", () => {
  it("POST refuses a head or member from another workspace", async () => {
    const { a, b } = await signedIn();
    for (const input of [
      { leadId: b.emp.id, members: [{ employeeId: b.emp.id }] },
      { leadId: a.emp.id, members: [{ employeeId: a.emp.id }, { employeeId: b.emp.id }] },
    ]) {
      const r = await call(createTeam, "POST", "/api/teams", { name: "Mixed", ...input });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("unknown_employee");
    }
    expect((await db.select().from(teams).where(eq(teams.name, "Mixed"))).length).toBe(0);
    const [fresh] = await db.insert(employees).values({ workspaceId: a.ws.id, name: "Nia", role: "PM", model: "m" }).returning();
    const ok = await call(createTeam, "POST", "/api/teams", { name: "Good", leadId: fresh!.id, members: [{ employeeId: fresh!.id }] });
    expect(ok.status).toBe(200);
  });

  it("PATCH refuses a head or member from another workspace", async () => {
    const { a, b } = await signedIn();
    const lead = await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { leadId: b.emp.id, members: [{ employeeId: b.emp.id }] }, { id: a.team.id });
    expect(lead.status).toBe(400);
    expect(lead.json.code).toBe("unknown_employee");
    const mem = await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { members: [{ employeeId: a.emp.id }, { employeeId: b.emp.id }] }, { id: a.team.id });
    expect(mem.status).toBe(400);
    const [team] = await db.select().from(teams).where(eq(teams.id, a.team.id));
    expect(team!.leadId).toBe(a.emp.id);
    expect(await db.select().from(teamMembers).where(eq(teamMembers.employeeId, b.emp.id))).toEqual([]);
    const ok = await callWithParams(patchTeam, "PATCH", `/api/teams/${a.team.id}`, { members: [{ employeeId: a.emp.id }] }, { id: a.team.id });
    expect(ok.status).toBe(200);
  });
});

describe("GET /api/employees/[id]/activity", () => {
  it("404s for another workspace's employee and only counts this workspace's steps", async () => {
    const { a, b } = await signedIn();
    await db.insert(steps).values([
      { workspaceId: a.ws.id, employeeId: a.emp.id, kind: "tool", name: "x", credits: 2 },
      // a stray step of the same employee id recorded under another workspace must not leak into the chart
      { workspaceId: b.ws.id, employeeId: a.emp.id, kind: "tool", name: "y", credits: 40 },
    ]);
    const mine = await callWithParams(activity, "GET", `/api/employees/${a.emp.id}/activity`, undefined, { id: a.emp.id });
    expect(mine.status).toBe(200);
    expect((mine.json.recent as unknown[]).length).toBe(1);
    expect((mine.json.daily as { credits: number }[]).reduce((s, d) => s + d.credits, 0)).toBe(2);
    const theirs = await callWithParams(activity, "GET", `/api/employees/${b.emp.id}/activity`, undefined, { id: b.emp.id });
    expect(theirs.status).toBe(404);
    expect(theirs.json.code).toBe("employee_not_found");
  });
});
