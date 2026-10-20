import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentWorkOnRepository, appDocuments, appModules, apps, appTests, approvals, db, employees, hrReviews, incidents, replays, repositories, tasks, teams, type AppDocumentKind } from "@wfos/db";
import { APPROVAL_UNDECIDABLE_TASK_STATUSES, type IncidentKind, type IncidentStatus, type TaskStatus } from "@wfos/shared";

/**
 * "Needs a decision": everything in a workspace that waits for a person, in one place. Approvals keep their own cards
 * (GET /api/approvals); this adds what is not an approval:
 * - incidents a person was asked to handle (escalated), or that no lead is handling (open, muted)
 * - tasks an employee proposed that wait for someone to start them (QUEUED, phase hold)
 * - employees paused because their budget ran out
 * - finished agent work that is not in its repository's default branch yet (or whose merge failed)
 * - app tests (C3) with findings nobody has dealt with yet
 * - app document drafts (C9) waiting to be approved or rejected
 * - instruction changes an HR review proposed whose replay did not pass the judge (C2): a person promotes or discards
 * - finished tasks whose result a person must accept (P4, review policy "person")
 */

/** incidents that wait for a person ("handling": a lead is on it; "resolved": done) */
export const PERSON_INCIDENT_STATUSES: IncidentStatus[] = ["escalated", "open", "muted"];
const PER_KIND = 50;

type Ref = { id: string; name: string } | null;

export type InboxItem =
  | { kind: "incident"; id: string; at: Date; incidentKind: IncidentKind; status: IncidentStatus; summary: string; task: { id: string; title: string; status: TaskStatus } | null; employee: Ref }
  | { kind: "held_task"; id: string; at: Date; title: string; employee: Ref; team: Ref }
  | { kind: "paused_employee"; id: string; at: Date; name: string; role: string }
  | { kind: "merge"; id: string; at: Date; title: string; employee: Ref; repository: { id: string; name: string; defaultBranch: string }; state: "unmerged" | "failed"; conflicts: string[] }
  | { kind: "test_findings"; id: string; at: Date; app: { id: string; name: string }; summary: string; findings: number; high: number; commit: string | null }
  | { kind: "doc_review"; id: string; at: Date; app: { id: string; name: string }; module: { id: string; name: string } | null; docKind: AppDocumentKind; version: number; title: string; note: string; author: string | null }
  | { kind: "hr_proposal"; id: string; at: Date; employee: { id: string; name: string }; verdicts: string[]; judgeError: string | null }
  | { kind: "task_review"; id: string; at: Date; title: string; employee: Ref; team: Ref; resumable: boolean };

export type InboxKind = InboxItem["kind"];
export interface Inbox {
  items: InboxItem[];
  /** pending approvals a person can decide now (their cards come from /api/approvals) */
  approvals: number;
  /** pending approvals of tasks whose employee is still working: decidable once the run ends */
  approvalsWaiting: number;
  counts: Record<InboxKind | "approval", number> & { total: number };
}

const ref = (id: string | null | undefined, name: string | null | undefined): Ref => (id && name ? { id, name } : null);

export async function inboxFor(workspaceId: string): Promise<Inbox> {
  const [approvalRows, incidentItems, held, paused, merges, tests, drafts, proposals, reviews] = await Promise.all([
    pendingApprovals(workspaceId),
    personIncidents(workspaceId),
    heldTasks(workspaceId),
    pausedEmployees(workspaceId),
    unmergedWork(workspaceId),
    testFindings(workspaceId),
    documentDrafts(workspaceId),
    hrProposals(workspaceId),
    taskReviews(workspaceId),
  ]);
  const items = [...incidentItems, ...held, ...paused, ...merges, ...tests, ...drafts, ...proposals, ...reviews].sort((a, b) => b.at.getTime() - a.at.getTime());
  const counts = {
    approval: approvalRows.decidable,
    incident: incidentItems.length,
    held_task: held.length,
    paused_employee: paused.length,
    merge: merges.length,
    test_findings: tests.length,
    doc_review: drafts.length,
    hr_proposal: proposals.length,
    task_review: reviews.length,
    total: 0,
  };
  counts.total = counts.approval + counts.incident + counts.held_task + counts.paused_employee + counts.merge + counts.test_findings + counts.doc_review + counts.hr_proposal + counts.task_review;
  return { items, approvals: approvalRows.decidable, approvalsWaiting: approvalRows.waiting, counts };
}

/** same rule as GET /api/approvals: a pending approval of a RUNNING / QUEUED task cannot be decided yet */
async function pendingApprovals(workspaceId: string): Promise<{ decidable: number; waiting: number }> {
  const [r] = await db
    .select({ all: count(), waiting: count(tasks.id) })
    .from(approvals)
    .leftJoin(tasks, and(eq(tasks.id, approvals.taskId), inArray(tasks.status, [...APPROVAL_UNDECIDABLE_TASK_STATUSES])))
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "PENDING")));
  const all = Number(r?.all ?? 0);
  const waiting = Number(r?.waiting ?? 0);
  return { decidable: all - waiting, waiting };
}

const incidentEmployee = alias(employees, "inbox_incident_employee");

async function personIncidents(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({
      i: incidents,
      task: { id: tasks.id, title: tasks.title, status: tasks.status },
      employee: { id: incidentEmployee.id, name: incidentEmployee.name },
    })
    .from(incidents)
    // joined rows must belong to the same workspace, whatever ids the row carries
    .leftJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.workspaceId, workspaceId)))
    .leftJoin(incidentEmployee, and(eq(incidentEmployee.id, incidents.employeeId), eq(incidentEmployee.workspaceId, workspaceId)))
    .where(and(eq(incidents.workspaceId, workspaceId), inArray(incidents.status, PERSON_INCIDENT_STATUSES)))
    .orderBy(desc(incidents.createdAt))
    .limit(PER_KIND);
  return rows.map((r) => ({
    kind: "incident" as const,
    id: r.i.id,
    at: r.i.createdAt,
    incidentKind: r.i.kind,
    status: r.i.status,
    summary: r.i.summary,
    task: r.task?.id ? r.task : null,
    employee: ref(r.employee?.id, r.employee?.name),
  }));
}

async function heldTasks(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, at: tasks.createdAt, employeeId: employees.id, employeeName: employees.name, teamId: teams.id, teamName: teams.name })
    .from(tasks)
    .leftJoin(employees, and(eq(employees.id, tasks.assigneeId), eq(employees.workspaceId, workspaceId)))
    .leftJoin(teams, and(eq(teams.id, tasks.teamId), eq(teams.workspaceId, workspaceId)))
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "QUEUED"), eq(tasks.phase, "hold")))
    .orderBy(desc(tasks.createdAt))
    .limit(PER_KIND);
  return rows.map((r) => ({ kind: "held_task" as const, id: r.id, at: r.at, title: r.title, employee: ref(r.employeeId, r.employeeName), team: ref(r.teamId, r.teamName) }));
}

/** P4: finished tasks whose result a person must accept (review policy "person") */
async function taskReviews(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, at: tasks.completedAt, created: tasks.createdAt, session: tasks.agentSessionId, employeeId: employees.id, employeeName: employees.name, teamId: teams.id, teamName: teams.name })
    .from(tasks)
    .leftJoin(employees, and(eq(employees.id, tasks.assigneeId), eq(employees.workspaceId, workspaceId)))
    .leftJoin(teams, and(eq(teams.id, tasks.teamId), eq(teams.workspaceId, workspaceId)))
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "DONE"), eq(tasks.reviewPolicy, "person"), isNull(tasks.reviewedAt)))
    .orderBy(desc(tasks.completedAt))
    .limit(PER_KIND);
  return rows.map((r) => ({ kind: "task_review" as const, id: r.id, at: r.at ?? r.created, title: r.title, employee: ref(r.employeeId, r.employeeName), team: ref(r.teamId, r.teamName), resumable: !!r.session }));
}

async function pausedEmployees(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ id: employees.id, name: employees.name, role: employees.role, at: employees.updatedAt })
    .from(employees)
    .where(and(eq(employees.workspaceId, workspaceId), eq(employees.status, "PAUSED_BUDGET")))
    .orderBy(desc(employees.updatedAt))
    .limit(PER_KIND);
  return rows.map((r) => ({ kind: "paused_employee" as const, ...r }));
}

async function unmergedWork(workspaceId: string): Promise<InboxItem[]> {
  const repos = await db
    .select({ id: repositories.id, name: repositories.name, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId));
  const perRepo = await Promise.all(
    repos.map(async (repo) =>
      (await agentWorkOnRepository(workspaceId, repo.id))
        // a failed merge needs a person whatever the task does now; plain unmerged work once its task is DONE
        .filter((w) => w.state === "failed" || (w.state === "unmerged" && w.status === "DONE"))
        .map((w) => ({ w, repo })),
    ),
  );
  const flat = perRepo.flat().sort((a, b) => b.w.pushedAt.getTime() - a.w.pushedAt.getTime());
  const ids = [...new Set(flat.map(({ w }) => w.assigneeId).filter((x): x is string => !!x))];
  const names = new Map(
    ids.length ? (await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, ids)))).map((e) => [e.id, e.name]) : [],
  );
  return flat.slice(0, PER_KIND).map(({ w, repo }) => ({
    kind: "merge" as const,
    id: w.taskId,
    at: w.pushedAt,
    title: w.title,
    employee: ref(w.assigneeId, w.assigneeId ? names.get(w.assigneeId) : null),
    repository: repo,
    state: w.state as "unmerged" | "failed",
    conflicts: w.decision?.conflicts ?? [],
  }));
}

async function testFindings(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ id: appTests.id, at: appTests.finishedAt, created: appTests.createdAt, summary: appTests.summary, findings: appTests.findings, commit: appTests.commit, appId: apps.id, appName: apps.name })
    .from(appTests)
    .innerJoin(apps, and(eq(apps.id, appTests.appId), eq(apps.workspaceId, workspaceId)))
    .where(and(eq(appTests.workspaceId, workspaceId), eq(appTests.status, "findings"), isNull(appTests.handledAt)))
    .orderBy(desc(appTests.createdAt))
    .limit(PER_KIND);
  return rows.map((r) => ({
    kind: "test_findings" as const,
    id: r.id,
    at: r.at ?? r.created,
    app: { id: r.appId, name: r.appName },
    summary: r.summary ?? "",
    findings: r.findings.length,
    high: r.findings.filter((f) => f.severity === "high").length,
    commit: r.commit,
  }));
}

async function documentDrafts(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ d: appDocuments, appName: apps.name, author: employees.name, moduleName: appModules.name })
    .from(appDocuments)
    .innerJoin(apps, and(eq(apps.id, appDocuments.appId), eq(apps.workspaceId, workspaceId)))
    .leftJoin(appModules, eq(appModules.id, appDocuments.moduleId))
    .leftJoin(employees, eq(employees.id, appDocuments.authorEmployeeId))
    .where(and(eq(appDocuments.workspaceId, workspaceId), eq(appDocuments.status, "draft")))
    .orderBy(desc(appDocuments.createdAt))
    .limit(PER_KIND);
  return rows.map((r) => ({
    kind: "doc_review" as const,
    id: r.d.id,
    at: r.d.createdAt,
    app: { id: r.d.appId, name: r.appName },
    // C8: a module's PRD is reviewed on the module
    module: r.d.moduleId ? { id: r.d.moduleId, name: r.moduleName ?? "" } : null,
    docKind: r.d.kind,
    version: r.d.version,
    title: r.d.title,
    note: r.d.note,
    author: r.author,
  }));
}

async function hrProposals(workspaceId: string): Promise<InboxItem[]> {
  const rows = await db
    .select({ id: replays.id, at: replays.createdAt, judge: replays.judge, employeeId: employees.id, employeeName: employees.name })
    .from(replays)
    .innerJoin(hrReviews, eq(hrReviews.id, replays.hrReviewId))
    .innerJoin(employees, and(eq(employees.id, replays.employeeId), eq(employees.workspaceId, workspaceId)))
    // judged and not passed (a passed one applied on its own; one still running is not a decision yet)
    .where(and(eq(replays.workspaceId, workspaceId), eq(replays.status, "done"), isNotNull(replays.judge)))
    .orderBy(desc(replays.createdAt))
    .limit(PER_KIND);
  return rows
    .filter((r) => !r.judge?.passed)
    .map((r) => ({ kind: "hr_proposal" as const, id: r.id, at: r.at, employee: { id: r.employeeId, name: r.employeeName }, verdicts: (r.judge?.verdicts ?? []).map((v) => v.verdict), judgeError: r.judge?.error ?? null }));
}
