import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, createTask, db, employees, members, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { POST as taskAction } from "@/app/api/tasks/[id]/actions/route";
import { GET as getInbox } from "@/app/api/inbox/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Pratiwi", role: "PM", model: "m" }).returning();
  const email = `m-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "MEMBER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { ws: ws!, emp: emp! };
}

describe("task work mode and review policy (P4)", () => {
  it("a plan-only task keeps its mode in its subtasks; defaults are standard and auto", async () => {
    const { ws, emp } = await setup();
    const r = await call(createTaskRoute, "POST", "/api/tasks", { title: "Plan the e-Procurement rollout", assigneeId: emp.id, workMode: "plan", reviewPolicy: "person", start: false });
    const t = r.json.task as { id: string; workMode: string; reviewPolicy: string };
    expect(t).toMatchObject({ workMode: "plan", reviewPolicy: "person" });
    const child = await createTask(db, { workspaceId: ws.id, title: "sub", source: "board", assigneeId: emp.id, parentTaskId: t.id });
    expect(child.workMode).toBe("plan");
    // a follow-up or handoff (origin) cannot be made standard by asking for it
    const follow = await createTask(db, { workspaceId: ws.id, title: "follow-up", source: "board", assigneeId: emp.id, originTaskId: t.id, workMode: "standard" });
    expect(follow.workMode).toBe("plan");
    const plain = (await call(createTaskRoute, "POST", "/api/tasks", { title: "x", assigneeId: emp.id, start: false })).json.task as { workMode: string; reviewPolicy: string };
    expect(plain).toMatchObject({ workMode: "standard", reviewPolicy: "auto" });
    expect((await call(createTaskRoute, "POST", "/api/tasks", { title: "x", assigneeId: emp.id, workMode: "yolo" })).status).toBe(400);
  });

  it("a finished task with a person's review waits in Needs a decision until a member accepts it", async () => {
    const { ws, emp } = await setup();
    const t = (await call(createTaskRoute, "POST", "/api/tasks", { title: "Draft the RFQ template", assigneeId: emp.id, reviewPolicy: "person", start: false })).json.task as { id: string };
    // not done yet: nothing to accept
    expect((await callWithParams(taskAction, "POST", `/api/tasks/${t.id}/actions`, { action: "accept" }, { id: t.id })).json.code).toBe("task_not_awaiting_review");
    await db.update(tasks).set({ status: "DONE", completedAt: new Date() }).where(eq(tasks.id, t.id));
    let inbox = await call(getInbox, "GET", "/api/inbox");
    expect((inbox.json.items as { kind: string; id: string }[]).filter((i) => i.kind === "task_review").map((i) => i.id)).toEqual([t.id]);
    expect((inbox.json.counts as { task_review: number }).task_review).toBe(1);

    expect((await callWithParams(taskAction, "POST", `/api/tasks/${t.id}/actions`, { action: "accept" }, { id: t.id })).status).toBe(200);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(row!.reviewedAt).toBeInstanceOf(Date);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "task.accepted"), eq(auditLog.targetId, t.id)))).toHaveLength(1);
    inbox = await call(getInbox, "GET", "/api/inbox");
    expect((inbox.json.items as { kind: string }[]).some((i) => i.kind === "task_review")).toBe(false);
    expect((await callWithParams(taskAction, "POST", `/api/tasks/${t.id}/actions`, { action: "accept" }, { id: t.id })).status).toBe(409);
    void ws;
  });
});
