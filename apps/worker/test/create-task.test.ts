import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { clients, createTask, db, projects, repositories, routineRuns, routines, tasks, teams, TaskInputError } from "@wfos/db";
import { buildTools } from "../src/tools/registry";
import { executeAction } from "../src/tools/actions";
import { dispatchRoutine, runRoutineJob } from "../src/scheduler/routines";
import { enqueueTask } from "../src/lib/redis";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

async function makeTeam(workspaceId: string, leadId: string | null) {
  const [t] = await db.insert(teams).values({ workspaceId, name: "Squad", leadId }).returning();
  return t!;
}
async function makeClient(workspaceId: string) {
  const [c] = await db.insert(clients).values({ workspaceId, name: "PT Maju", email: "ap@maju.co.id" }).returning();
  return c!;
}
async function makeProject(workspaceId: string, clientId: string) {
  const [p] = await db.insert(projects).values({ workspaceId, clientId, name: "Website" }).returning();
  return p!;
}
async function makeRepo(workspaceId: string) {
  const [r] = await db.insert(repositories).values({ workspaceId, name: `r-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/x/y.git" }).returning();
  return r!;
}

/** Two workspaces, each with an employee, a led team, a client, a project, a repo and a task. */
async function world() {
  const make = async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "create_task", enabled: true }] });
    const team = await makeTeam(ws.id, emp.id);
    const client = await makeClient(ws.id);
    const project = await makeProject(ws.id, client.id);
    const repo = await makeRepo(ws.id);
    const task = await makeTask(ws.id, emp.id);
    return { ws, emp, team, client, project, repo, task };
  };
  return { a: await make(), b: await make() };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaskInputError) return e.code;
    throw e;
  }
  return "ok";
}

describe("createTask", () => {
  it("creates a task with every reference from the same workspace", async () => {
    const { a } = await world();
    const t = await createTask(db, {
      workspaceId: a.ws.id,
      title: "Monthly report",
      brief: "Summarise",
      source: "board",
      assigneeId: a.emp.id,
      teamId: a.team.id,
      clientId: a.client.id,
      projectId: a.project.id,
      repositoryId: a.repo.id,
      parentTaskId: a.task.id,
      originTaskId: a.task.id,
      dryRun: true,
      phase: "hold",
    });
    expect(t).toMatchObject({
      workspaceId: a.ws.id,
      title: "Monthly report",
      brief: "Summarise",
      status: "QUEUED",
      source: "board",
      assigneeId: a.emp.id,
      teamId: a.team.id,
      clientId: a.client.id,
      projectId: a.project.id,
      repositoryId: a.repo.id,
      parentTaskId: a.task.id,
      originTaskId: a.task.id,
      dryRun: true,
      phase: "hold",
      createdBy: null,
    });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(row!.id).toBe(t.id);
    // the helper only inserts: publishing and enqueueing stay with the caller
    expect(transport.published).toEqual([]);
    expect(transport.queued).toEqual([]);
  });

  it.each([
    ["assigneeId", "unknown_employee"],
    ["teamId", "unknown_team"],
    ["clientId", "unknown_client"],
    ["projectId", "unknown_project"],
    ["repositoryId", "repository_not_found"],
    ["parentTaskId", "unknown_parent_task"],
    ["originTaskId", "unknown_origin_task"],
  ] as const)("rejects a %s from another workspace (%s) and inserts nothing", async (field, expected) => {
    const { a, b } = await world();
    const foreign = { assigneeId: b.emp.id, teamId: b.team.id, clientId: b.client.id, projectId: b.project.id, repositoryId: b.repo.id, parentTaskId: b.task.id, originTaskId: b.task.id }[field];
    const before = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, a.ws.id))).length;
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", assigneeId: a.emp.id, [field]: foreign }))).toBe(expected);
    expect((await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, a.ws.id))).length).toBe(before);
  });

  it("rejects unknown and malformed ids", async () => {
    const { a } = await world();
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", assigneeId: randomUUID() }))).toBe("unknown_employee");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", assigneeId: "not-a-uuid" }))).toBe("unknown_employee");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", teamId: "nope" }))).toBe("unknown_team");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", assigneeId: a.emp.id, clientId: "nope" }))).toBe("unknown_client");
  });

  it("rejects a team whose Lead belongs to another workspace", async () => {
    const { a, b } = await world();
    const crooked = await makeTeam(a.ws.id, b.emp.id);
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", teamId: crooked.id }))).toBe("unknown_team_lead");
  });

  it("needs an assignee or a team, and a team needs a Lead (the board's rules) unless the caller relaxes them", async () => {
    const { a } = await world();
    const leaderless = await makeTeam(a.ws.id, null);
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board" }))).toBe("task_needs_assignee");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", teamId: leaderless.id }))).toBe("team_has_no_lead");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "routine", requireAssignee: false }))).toBe("ok");
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "routine", teamId: leaderless.id, requireTeamLead: false }))).toBe("ok");
    // a team with a Lead works without an assignee
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "board", teamId: a.team.id }))).toBe("ok");
  });

  it("rejects an unknown source", async () => {
    const { a } = await world();
    // @ts-expect-error: a value outside TASK_SOURCES
    expect(await code(createTask(db, { workspaceId: a.ws.id, title: "x", source: "email", assigneeId: a.emp.id }))).toBe("invalid_task_source");
  });

  it("works inside a transaction", async () => {
    const { a } = await world();
    const t = await db.transaction((tx) => createTask(tx, { workspaceId: a.ws.id, title: "tx", source: "board", assigneeId: a.emp.id }));
    expect(t.title).toBe("tx");
  });
});

describe("createTask callers", () => {
  it("create_task tool keeps its fields and refuses another workspace's employee or client", async () => {
    const { a, b } = await world();
    const ctx = runContext(a.ws, a.emp, a.task.id, { dryRun: true });
    const tool = buildTools(ctx).find((d) => d.name === "create_task")!;
    const r = await tool.handler({ title: "Follow up", brief: "Call them", clientId: a.client.id, start: false }, {});
    expect(r.isError).toBeFalsy();
    const [created] = await db.select().from(tasks).where(eq(tasks.id, ctx.createdTaskIds[0]!));
    expect(created).toMatchObject({ assigneeId: a.emp.id, clientId: a.client.id, source: "board", dryRun: true, phase: "hold", createdBy: null, status: "QUEUED" });
    expect(transport.published.some((p) => (p.ev as { type: string; taskId?: string }).type === "task.created" && (p.ev as { taskId: string }).taskId === created!.id)).toBe(true);

    for (const args of [{ assigneeId: b.emp.id }, { clientId: b.client.id }]) {
      const bad = await tool.handler({ title: "Sneaky", brief: "x", ...args }, {});
      expect(bad.isError).toBe(true);
    }
    expect(ctx.createdTaskIds).toHaveLength(1);
    expect((await db.select().from(tasks).where(eq(tasks.title, "Sneaky"))).length).toBe(0);
  });

  it("delegate_subtask creates a team subtask under the parent with its client and project", async () => {
    const { a } = await world();
    const member = await makeEmployee(a.ws.id);
    const parent = await makeTask(a.ws.id, a.emp.id, { teamId: a.team.id, clientId: a.client.id, projectId: a.project.id });
    const ctx = runContext(a.ws, a.emp, parent.id, { team: { teamId: a.team.id, role: "lead", phase: "plan", memberIds: [a.emp.id, member.id] } });
    const tool = buildTools(ctx).find((d) => d.name === "delegate_subtask")!;
    const r = await tool.handler({ assigneeId: member.id, title: "Draft section", brief: "Write it", acceptanceCriteria: "Two pages" }, {});
    expect(r.isError).toBeFalsy();
    const [sub] = await db.select().from(tasks).where(eq(tasks.id, ctx.delegatedTaskIds[0]!));
    expect(sub).toMatchObject({
      assigneeId: member.id,
      parentTaskId: parent.id,
      teamId: a.team.id,
      clientId: a.client.id,
      projectId: a.project.id,
      source: "team",
      dryRun: false,
      phase: null,
      brief: "Write it\n\nAcceptance criteria:\nTwo pages",
    });
  });

  it("dispatchRoutine keeps its fields, and a routine pointing at another workspace's employee fails", async () => {
    const { a, b } = await world();
    const [r] = await db.insert(routines).values({ workspaceId: a.ws.id, name: "Weekly", cron: "0 9 * * 1", brief: "Report for {{client.name}}", assigneeId: a.emp.id, perClient: true, dryRun: true }).returning();
    const ids = await dispatchRoutine(r!, "manual", undefined);
    expect(ids).toHaveLength(1);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, ids[0]!));
    expect(t).toMatchObject({ assigneeId: a.emp.id, clientId: a.client.id, routineId: r!.id, source: "routine", dryRun: true, phase: null, createdBy: null });
    expect(t!.brief).toBe(`Report for PT Maju\n\nClient id: ${a.client.id}`);
    expect(transport.queued.some((q) => (q.data as { taskId?: string }).taskId === t!.id)).toBe(true);

    const [bad] = await db.insert(routines).values({ workspaceId: a.ws.id, name: "Bad", cron: "0 9 * * 1", brief: "x", assigneeId: b.emp.id }).returning();
    await expect(dispatchRoutine(bad!, "schedule")).rejects.toBeInstanceOf(TaskInputError);
    expect((await db.select().from(tasks).where(eq(tasks.routineId, bad!.id))).length).toBe(0);
  });

  it("a firing that fails part-way records the failed run with the tasks already created", async () => {
    const { a } = await world();
    await db.insert(clients).values({ workspaceId: a.ws.id, name: "PT Kedua", email: "dua@client.co.id" });
    const [r] = await db.insert(routines).values({ workspaceId: a.ws.id, name: "Per client", cron: "0 9 * * 1", brief: "Report", assigneeId: a.emp.id, perClient: true }).returning();
    const enqueue = vi.mocked(enqueueTask);
    const orig = enqueue.getMockImplementation()!;
    let n = 0;
    enqueue.mockImplementation(async (...args) => {
      if (++n === 2) throw new Error("redis down");
      return orig(...args);
    });
    try {
      await expect(dispatchRoutine(r!, "schedule")).rejects.toThrow("redis down");
    } finally {
      enqueue.mockImplementation(orig);
    }
    const created = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.routineId, r!.id));
    expect(created).toHaveLength(2); // the second was created, its enqueue failed
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, r!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", error: "redis down", trigger: "schedule" });
    expect([...runs[0]!.taskIds].sort()).toEqual(created.map((t) => t.id).sort());
  });

  it("a manual run refused by createTask records the failure and does not throw (no pointless retries)", async () => {
    const { a, b } = await world();
    const [bad] = await db.insert(routines).values({ workspaceId: a.ws.id, name: "Bad", cron: "0 9 * * 1", brief: "x", assigneeId: b.emp.id }).returning();
    await expect(runRoutineJob(bad!.id, undefined)).resolves.toEqual([]);
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, bad!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", trigger: "manual", taskIds: [] });
    expect(runs[0]!.error).toBeTruthy();
    expect(await runRoutineJob(randomUUID())).toEqual([]); // deleted routine
  });

  it("handoff_prd creates the Developer task and refuses another workspace's client", async () => {
    const { a, b } = await world();
    const ok = await executeAction(a.ws.id, "handoff_prd", { title: "CSV", prd: "Do it", developerId: a.emp.id, repositoryId: a.repo.id, clientId: a.client.id }, { taskId: a.task.id });
    expect(ok.ok).toBe(true);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, (ok.details as { taskId: string }).taskId));
    expect(t).toMatchObject({ title: "Implement: CSV", assigneeId: a.emp.id, originTaskId: a.task.id, repositoryId: a.repo.id, clientId: a.client.id, source: "board", status: "QUEUED" });

    const repoBad = await executeAction(a.ws.id, "handoff_prd", { title: "CSV", prd: "x", developerId: a.emp.id, repositoryId: b.repo.id }, { taskId: a.task.id });
    expect(repoBad).toEqual({ ok: false, summary: "The chosen repository does not exist in this workspace." });
    const clientBad = await executeAction(a.ws.id, "handoff_prd", { title: "CSV2", prd: "x", developerId: a.emp.id, clientId: b.client.id }, { taskId: a.task.id });
    expect(clientBad.ok).toBe(false);
    expect((await db.select().from(tasks).where(eq(tasks.title, "Implement: CSV2"))).length).toBe(0);
  });
});
