import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, employees, hrReviews, members, replays, tasks, users, workspaces } from "@wfos/db";
import type { Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as getHr, POST as startHr } from "@/app/api/employees/[id]/hr/route";
import { GET as inbox } from "@/app/api/inbox/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `h-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "P", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Bima", role: "Backend Developer", model: "m" }).returning();
  const [hr] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sinta", role: "HR Manager", model: "m" }).returning();
  for (const status of ["DONE", "DONE", "DONE", "FAILED"] as const) await db.insert(tasks).values({ workspaceId: ws!.id, title: "t", assigneeId: emp!.id, status, completedAt: new Date() });
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, emp: emp!, hr: hr! };
}
const at = (id: string, q = "") => `/api/employees/${id}/hr${q}`;

describe("HR (C2)", () => {
  it("members see the measured work and the platform's score", async () => {
    const s = await setup("MEMBER");
    const r = await callWithParams(getHr, "GET", at(s.emp.id, "?days=30"), undefined, { id: s.emp.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ metrics: { days: 30, tasks: { done: 3, failed: 1 }, successRate: 0.75 }, metricScore: 4, reviews: [] });
    // starting a review is an Admin's
    expect((await callWithParams(startHr, "POST", at(s.emp.id), { reviewerId: s.hr.id }, { id: s.emp.id })).status).toBe(403);
  });

  it("an Admin starts a review: metrics measured now, a task for the HR employee, audited; never the employee itself", async () => {
    const s = await setup("ADMIN");
    const r = await callWithParams(startHr, "POST", at(s.emp.id), { reviewerId: s.hr.id, days: 60 }, { id: s.emp.id });
    expect(r.status).toBe(200);
    const [rv] = await db.select().from(hrReviews).where(eq(hrReviews.id, r.json.reviewId as string));
    expect(rv).toMatchObject({ employeeId: s.emp.id, periodDays: 60, metricScore: 4, status: "running", reviewerTaskId: r.json.taskId });
    expect(rv!.metrics.tasks.done).toBe(3);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(task).toMatchObject({ assigneeId: s.hr.id, status: "QUEUED" });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "employee.hr_review_started"), eq(auditLog.targetId, s.emp.id)))).toHaveLength(1);
    expect((await callWithParams(startHr, "POST", at(s.emp.id), { reviewerId: s.emp.id }, { id: s.emp.id })).json.code).toBe("reviewer_not_found");
    const list = await callWithParams(getHr, "GET", at(s.emp.id), undefined, { id: s.emp.id });
    expect((list.json.reviews as { id: string; reviewer: string; status: string }[])[0]).toMatchObject({ id: rv!.id, reviewer: "Sinta", status: "running" });
  });

  it("a proposal that did not pass its replay waits in Needs a decision; a passed (applied) one does not", async () => {
    const s = await setup("ADMIN");
    const metrics = { days: 30, tasks: { done: 0, failed: 0, cancelled: 0, total: 0 }, successRate: null, incidents: { total: 0, byKind: {} }, approvals: { requested: 0, executed: 0, rejected: 0, edited: 0, expired: 0 }, changesRequested: 0, credits: 0, activeMinutes: 0, costliestTasks: [] };
    const [rv] = await db.insert(hrReviews).values({ workspaceId: s.ws.id, employeeId: s.emp.id, metrics, status: "done" }).returning();
    const proposed = { persona: "", instructions: "x", businessContext: "" };
    const [failed] = await db
      .insert(replays)
      .values({ workspaceId: s.ws.id, employeeId: s.emp.id, proposed, status: "done", hrReviewId: rv!.id, judge: { passed: false, model: "m", verdicts: [{ taskId: "a", verdict: "worse", reason: "r" }] } })
      .returning();
    await db.insert(replays).values({ workspaceId: s.ws.id, employeeId: s.emp.id, proposed, status: "promoted", autoApplied: true, hrReviewId: rv!.id, judge: { passed: true, model: "m", verdicts: [{ taskId: "a", verdict: "better", reason: "r" }] } });
    const box = await callWithParams(inbox, "GET", "/api/inbox", undefined, {});
    const items = (box.json.items as { kind: string; id: string }[]).filter((x) => x.kind === "hr_proposal");
    expect(items).toEqual([expect.objectContaining({ id: failed!.id, employee: { id: s.emp.id, name: "Bima" }, verdicts: ["worse"] })]);
  });
});
