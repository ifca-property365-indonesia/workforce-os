import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { clients, createTask, db, employees, goals, members, projects, steps, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listGoals, POST as createGoal } from "@/app/api/goals/route";
import { DELETE as deleteGoal, PATCH as patchGoal } from "@/app/api/goals/[id]/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { PUT as setTaskGoal } from "@/app/api/tasks/[id]/goal/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup(role: "ADMIN" | "MEMBER" = "ADMIN") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Bima", role: "Backend", model: "m" }).returning();
  const email = `g-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { ws: ws!, emp: emp! };
}
type G = { id: string; title: string; parentId: string | null; stats: { open: number; done: number; credits: number; projects: number }; total: { open: number; done: number; credits: number; credits30d: number } };

describe("goals (P1)", () => {
  it("goals form a tree; tasks inherit the project's or parent's goal; credits add up to the goals above", async () => {
    const { ws, emp } = await setup();
    const top = (await call(createGoal, "POST", "/api/goals", { title: "Grow recurring revenue" })).json.goal as { id: string };
    const sub = (await call(createGoal, "POST", "/api/goals", { title: "Launch e-Procurement", parentId: top.id })).json.goal as { id: string };
    const [client] = await db.insert(clients).values({ workspaceId: ws.id, name: "GOB" }).returning();
    const [project] = await db.insert(projects).values({ workspaceId: ws.id, clientId: client!.id, name: "eProc", goalId: sub.id }).returning();

    // a board task in the project inherits its goal; a subtask the parent's; an explicit null means none
    const r = await call(createTaskRoute, "POST", "/api/tasks", { title: "Build vendor module", assigneeId: emp.id, projectId: project!.id, start: false });
    const parent = r.json.task as { id: string; goalId: string | null };
    expect(parent.goalId).toBe(sub.id);
    const child = await createTask(db, { workspaceId: ws.id, title: "sub", source: "board", assigneeId: emp.id, parentTaskId: parent.id });
    expect(child.goalId).toBe(sub.id);
    const none = await call(createTaskRoute, "POST", "/api/tasks", { title: "Other", assigneeId: emp.id, projectId: project!.id, goalId: null, start: false });
    expect((none.json.task as { goalId: string | null }).goalId).toBeNull();
    expect((await call(createTaskRoute, "POST", "/api/tasks", { title: "x", assigneeId: emp.id, goalId: randomUUID(), start: false })).json.code).toBe("unknown_goal");

    await db.update(tasks).set({ status: "DONE", costCredits: 40 }).where(eq(tasks.id, child.id));
    await db.update(tasks).set({ costCredits: 10 }).where(eq(tasks.id, parent.id));
    await db.insert(steps).values({ workspaceId: ws.id, taskId: child.id, employeeId: emp.id, kind: "llm", name: "x", credits: 40 });

    const list = (await call(listGoals, "GET", "/api/goals")).json.goals as G[];
    const s = list.find((g) => g.id === sub.id)!;
    const t = list.find((g) => g.id === top.id)!;
    expect(s.stats).toMatchObject({ open: 1, done: 1, credits: 50, projects: 1 });
    expect(t.stats).toMatchObject({ open: 0, done: 0, credits: 0 });
    expect(t.total).toMatchObject({ open: 1, done: 1, credits: 50, credits30d: 40 });

    // no cycles; delete moves the goals under it up
    expect((await callWithParams(patchGoal, "PATCH", `/api/goals/${top.id}`, { parentId: sub.id }, { id: top.id })).json.code).toBe("goal_cycle");
    expect((await callWithParams(deleteGoal, "DELETE", `/api/goals/${top.id}`, undefined, { id: top.id })).status).toBe(200);
    expect((await db.select().from(goals).where(eq(goals.id, sub.id)))[0]!.parentId).toBeNull();

    // a person moves a task to another goal: its subtasks follow
    const other = (await call(createGoal, "POST", "/api/goals", { title: "Cut support load" })).json.goal as { id: string };
    expect((await callWithParams(setTaskGoal, "PUT", `/api/tasks/${parent.id}/goal`, { goalId: other.id }, { id: parent.id })).status).toBe(200);
    expect((await db.select({ g: tasks.goalId }).from(tasks).where(eq(tasks.id, child.id)))[0]!.g).toBe(other.id);
  });

  it("members see goals but only Admins change them; another workspace's goal is unknown", async () => {
    const a = await setup();
    const mine = (await call(createGoal, "POST", "/api/goals", { title: "Mine" })).json.goal as { id: string };
    const b = await setup("MEMBER");
    expect((await call(listGoals, "GET", "/api/goals")).json.goals).toEqual([]);
    expect((await call(createGoal, "POST", "/api/goals", { title: "x" })).status).toBe(403);
    expect((await call(createTaskRoute, "POST", "/api/tasks", { title: "x", assigneeId: b.emp.id, goalId: mine.id, start: false })).json.code).toBe("unknown_goal");
    void a;
  });
});
