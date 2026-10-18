import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, employeeMetrics, employees, hrReviews, metricScore, replays, tasks } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { notFound, body, route } from "@/lib/server/route";
import { publish, q } from "@/lib/server/queue";
import { createTaskOr400 } from "@/lib/server/tasks";

async function loadEmployee(workspaceId: string, id: string) {
  const [e] = await db.select().from(employees).where(and(eq(employees.id, id), eq(employees.workspaceId, workspaceId)));
  if (!e) notFound("employee_not_found");
  return e;
}

/**
 * C2: an employee's measured work (exact, computed now) and the platform's score, and its HR reviews with what became
 * of their instruction proposals (replay running, applied after a passed replay, or waiting for a person).
 */
export const GET = route<{ id: string }>("MEMBER", async ({ session, req, params }) => {
  const e = await loadEmployee(session.workspaceId, params.id);
  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 30));
  const metrics = await employeeMetrics(session.workspaceId, e.id, days);
  const rows = await db
    .select({ r: hrReviews, reviewer: employees.name, taskStatus: tasks.status, replay: { id: replays.id, status: replays.status, judge: replays.judge, autoApplied: replays.autoApplied, proposed: replays.proposed } })
    .from(hrReviews)
    .leftJoin(tasks, eq(tasks.id, hrReviews.reviewerTaskId))
    .leftJoin(employees, eq(employees.id, tasks.assigneeId))
    .leftJoin(replays, eq(replays.id, hrReviews.replayId))
    .where(and(eq(hrReviews.employeeId, e.id), eq(hrReviews.workspaceId, session.workspaceId)))
    .orderBy(desc(hrReviews.createdAt))
    .limit(10);
  return {
    metrics,
    metricScore: metricScore(metrics),
    reviews: rows.map((x) => ({
      id: x.r.id,
      status: x.r.status === "running" && x.taskStatus && ["DONE", "FAILED", "CANCELLED"].includes(x.taskStatus) ? "error" : x.r.status,
      score: x.r.score,
      metricScore: x.r.metricScore,
      summary: x.r.summary,
      strengths: x.r.strengths,
      issues: x.r.issues,
      recommendations: x.r.recommendations,
      reviewer: x.reviewer,
      taskId: x.r.reviewerTaskId,
      createdAt: x.r.createdAt,
      replay: x.replay?.id ? x.replay : null,
    })),
  };
});

const schema = z.object({ reviewerId: z.string().uuid(), days: z.number().int().min(7).max(90).default(30) });

/**
 * Start an HR review: the metrics are measured now (the review is about these numbers) and an HR employee gets a
 * task to assess them. Admins: a review may end in an instruction change (only after a passed replay).
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const b = await body(req, schema);
  const e = await loadEmployee(session.workspaceId, params.id);
  const [hr] = await db.select().from(employees).where(and(eq(employees.id, b.reviewerId), eq(employees.workspaceId, session.workspaceId)));
  if (!hr || hr.status === "ARCHIVED" || hr.id === e.id) throw new HttpError(400, "Choose another employee of this workspace as the reviewer", { code: "reviewer_not_found" });
  const metrics = await employeeMetrics(session.workspaceId, e.id, b.days);
  const task = await createTaskOr400(db, {
    workspaceId: session.workspaceId,
    title: `Review HR: ${e.name}`.slice(0, 200),
    brief: `Review ${e.name} (${e.role}) from the measured work of the last ${b.days} days and submit it with submit_hr_review.`,
    assigneeId: hr.id,
    source: "board",
    createdBy: session.userId,
  });
  const [review] = await db
    .insert(hrReviews)
    .values({ workspaceId: session.workspaceId, employeeId: e.id, reviewerTaskId: task.id, periodDays: b.days, metrics, metricScore: metricScore(metrics), createdBy: session.userId })
    .returning();
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "employee.hr_review_started", targetType: "employee", targetId: e.id, details: { reviewId: review!.id, reviewer: hr.name, days: b.days } });
  await publish(session.workspaceId, { type: "task.created", taskId: task.id, title: task.title, employeeId: hr.id });
  await q.task(task.id, session.workspaceId);
  return { reviewId: review!.id, taskId: task.id };
});
