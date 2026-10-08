import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approvals, clients, db, employees, projects, repositories, tasks, workspaceDepartments } from "@wfos/db";
import { ROLE_TEMPLATES } from "@wfos/templates";
import { decryptSecret } from "@wfos/shared/server";
import { prepareTaskRepo, syncMirror, type RepoRef } from "./workspace/git";
import { assertTransition, type TaskStatus } from "@wfos/shared";
import { enqueueTask, miscQueue, publish } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { getWorkspace, workspaceLocale } from "../lib/settings";
import { activeQuotaPause } from "../lib/limits";
import { employeeOutputLocale } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { log } from "../lib/logger";
import { checkBudget, pauseForBudget } from "../guards/budget";
import { grantedToolNames, unreadMessagesFor, type RunContext } from "../tools/registry";
import { buildSystemPrompt, recallMemories, workspaceDirectory } from "./prompt";
import { MissingCredentialError, WorkspaceBusyError, runAgent } from "./executor";
import { onChildFinished, planPrompt, requestRevisions, resolveExecutor, reviewPrompt } from "../orchestration/team";
import { scriptedTaskRun } from "../simulation/demo";

type Task = typeof tasks.$inferSelect;

export async function setTaskStatus(task: Pick<Task, "id" | "workspaceId" | "status" | "assigneeId" | "title">, to: TaskStatus, extra: Partial<Task> = {}): Promise<void> {
  assertTransition(task.status, to);
  const now = new Date();
  await db
    .update(tasks)
    .set({
      status: to,
      ...(to === "RUNNING" ? { startedAt: now } : {}),
      ...(to === "DONE" || to === "FAILED" || to === "CANCELLED" ? { completedAt: now } : {}),
      ...extra,
    })
    .where(eq(tasks.id, task.id));
  await publish(task.workspaceId, { type: "task.updated", taskId: task.id, status: to, employeeId: task.assigneeId, title: task.title });
}

async function taskContext(task: Task): Promise<string> {
  const parts: string[] = [];
  if (task.clientId) {
    const [c] = await db.select().from(clients).where(eq(clients.id, task.clientId));
    if (c) parts.push(`Client: ${c.name} (id ${c.id}, email ${c.email || "n/a"}, contacts: ${c.contacts.map((x) => `${x.name} <${x.email}>`).join(", ") || "n/a"}). Notes: ${c.notes}`);
  }
  if (task.projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, task.projectId));
    if (p) parts.push(`Project: ${p.name} (${p.status}) — ${p.description}`);
  }
  if (task.parentTaskId) {
    const [p] = await db.select({ title: tasks.title, brief: tasks.brief }).from(tasks).where(eq(tasks.id, task.parentTaskId));
    if (p) parts.push(`This is a subtask of "${p.title}". Overall goal:\n${p.brief.slice(0, 2000)}`);
  }
  return parts.join("\n");
}

export async function runTask(taskId: string, resumeNote?: string): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return;
  // A team parent stays RUNNING while members work; it re-enters here for the lead's review phase.
  const leadReview = task.status === "RUNNING" && task.phase === "review";
  if (task.status !== "QUEUED" && !leadReview) {
    log.info({ taskId, status: task.status }, "task not queued; skipping");
    return;
  }
  if (task.phase === "hold") return;
  const ws = await getWorkspace(task.workspaceId);
  if (ws.killSwitch) {
    await recordStep({ workspaceId: ws.id, taskId, kind: "system", name: "kill_switch_engaged", status: "blocked" });
    return;
  }

  const { employeeId, team } = await resolveExecutor(task);
  if (!employeeId) {
    await setTaskStatus(task, "FAILED", { error: "Task has no assignee (and no team lead)." });
    return;
  }
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  if (!emp) {
    await setTaskStatus(task, "FAILED", { error: "Assignee not found." });
    return;
  }
  if (emp.status !== "ACTIVE") {
    await recordStep({ workspaceId: ws.id, taskId, employeeId, kind: "system", name: "employee_not_active", status: "blocked", output: { status: emp.status } });
    await db.update(tasks).set({ error: `Waiting: ${emp.name} is ${emp.status}` }).where(eq(tasks.id, taskId));
    return;
  }

  // subscription limit reached: hold the queue until it resets (resumes automatically)
  const quota = await activeQuotaPause(ws.id);
  if (quota && !(ws.demoMode || task.source === "demo")) {
    await db.update(tasks).set({ error: `Paused: ${quota.reason}` }).where(eq(tasks.id, taskId));
    await enqueueTask(task.id, ws.id, resumeNote, Math.max(1000, quota.until.getTime() - Date.now() + 5000));
    return;
  }

  if (ws.demoMode || task.source === "demo") {
    await scriptedTaskRun(task, emp);
    return;
  }

  const budget = await checkBudget(ws.id, emp.id);
  if (!budget.ok) {
    await pauseForBudget(ws.id, emp.id, budget.reason!, taskId);
    await db.update(tasks).set({ error: `Paused: ${budget.reason}` }).where(eq(tasks.id, taskId));
    await miscQueue.add("notify", { kind: "notify", workspaceId: ws.id, subject: msg(ws.defaultLocale, "notify.pausedBudget", { name: emp.name }), text: budget.reason!, link: `/employees/${emp.id}` });
    return;
  }

  await setTaskStatus(task, "RUNNING", { error: null });

  // Workspace mode with a repository: refresh the platform mirror, then clone/refresh inside the sandbox
  let repository: (RepoRef & { name: string }) | undefined;
  if (emp.executionMode === "workspace" && !team && task.repositoryId) {
    const [r] = await db.select().from(repositories).where(and(eq(repositories.id, task.repositoryId), eq(repositories.workspaceId, ws.id)));
    if (!r) {
      await setTaskStatus({ ...task, status: "RUNNING" }, "FAILED", { error: "The task's repository no longer exists." });
      return;
    }
    repository = { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, token: r.tokenEnc ? decryptSecret(r.tokenEnc) : null };
    try {
      await syncMirror(repository);
      await prepareTaskRepo({ workspaceId: ws.id, taskId: task.id, repo: repository });
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "repository_prepared", output: { repository: r.name, branch: `agent/${task.id}` } });
    } catch (e) {
      const msg = `Could not prepare repository ${r.name}: ${(e as Error).message}`.replace(/Authorization: [^\s]+ [^\s]+/g, "Authorization: ***");
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "repository_failed", status: "error", output: msg });
      await setTaskStatus({ ...task, status: "RUNNING" }, "FAILED", { error: msg });
      return;
    }
  }

  const ctx: RunContext = {
    runId: randomUUID(),
    workspaceId: ws.id,
    employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
    taskId: task.id,
    conversationId: null,
    dryRun: task.dryRun,
    sandboxed: false,
    guard: { workspaceId: ws.id, taskId: task.id, conversationId: null, employeeId: emp.id, enabled: ws.guardsEnabled, tainted: false },
    pendingApprovalIds: [],
    deliverables: [],
    createdTaskIds: [],
    delegatedTaskIds: [],
    revisionRequests: [],
    team,
    ...(emp.executionMode === "workspace" && !team
      ? {
          workspace: {
            egressDomains: emp.egressDomains,
            // follow-ups on the same task resume the same Claude session in the same workspace
            resume: task.agentSessionId ?? undefined,
            onSession: async (sessionId: string) => {
              await db.update(tasks).set({ agentSessionId: sessionId, workspaceStatus: "active" }).where(eq(tasks.id, task.id));
            },
            repository,
          },
        }
      : {}),
  };

  const [mem, directory, context, inbox] = await Promise.all([
    recallMemories(emp.id, `${task.title}\n${task.brief}`),
    workspaceDirectory(ws.id),
    taskContext(task),
    unreadMessagesFor(emp.id),
  ]);

  const promptParts = [`# Task: ${task.title}`, task.brief, context && `## Context\n${context}`];
  if (inbox.length) promptParts.push(`## Messages from colleagues\n${inbox.map((m) => `- ${m.from ?? "system"} (${m.intent}): ${m.content}`).join("\n")}`);
  if (team?.role === "lead" && team.phase === "plan") promptParts.push(await planPrompt(task, team));
  if (team?.role === "lead" && team.phase === "review") promptParts.push(await reviewPrompt(task));
  if (resumeNote) promptParts.push(`## Update since your last attempt\n${resumeNote}`);
  if (task.deliverables.length && !(team?.role === "lead" && team.phase === "review")) {
    promptParts.push(`## Your previous deliverables on this task\n${task.deliverables.map((d) => `- ${d.title} (${d.kind})`).join("\n")}`);
  }

  // department SOP (in the employee's output language) and, in Workspace mode, its subagents
  const deptKey = emp.department ?? ROLE_TEMPLATES.find((t) => t.key === emp.templateKey)?.department ?? null;
  const dept = deptKey ? (await workspaceDepartments(ws.id)).find((d) => d.key === deptKey) : undefined;
  const lang = employeeOutputLocale(emp.outputLanguage, ws.defaultLocale) ?? "en";
  const agents =
    dept && ctx.workspace
      ? Object.fromEntries(dept.subagents.map((a) => [a.name, { description: a.description[lang], prompt: a.prompt[lang], ...(a.tools ? { tools: a.tools } : {}) }]))
      : undefined;

  const systemPrompt = buildSystemPrompt({
    employee: emp,
    workspaceName: ws.name,
    memories: mem,
    directory,
    grantedTools: grantedToolNames(ctx).map((n) => n.split("__").pop()!),
    dryRun: task.dryRun,
    mode: "task",
    workspace: ctx.workspace ? { egressDomains: ctx.workspace.egressDomains, hasRepository: !!task.repositoryId } : undefined,
    department: dept ? { name: dept.name[lang], sop: dept.sop[lang], subagents: agents ? Object.keys(agents) : [] } : undefined,
    outputLocale: employeeOutputLocale(emp.outputLanguage, ws.defaultLocale),
  });

  let out;
  try {
    out = await runAgent({ ctx, model: emp.model, systemPrompt, prompt: promptParts.filter(Boolean).join("\n\n"), creditBudget: budget.remaining, agents });
  } catch (e) {
    if (e instanceof WorkspaceBusyError) {
      // not a failure: wait for a free sandbox slot
      await setTaskStatus({ ...task, status: "RUNNING" }, "QUEUED", { error: null });
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "workspace_slot_busy", status: "waiting" });
      await enqueueTask(task.id, ws.id, resumeNote, 15_000);
      return;
    }
    const msg = e instanceof MissingCredentialError ? e.message : `Runner error: ${(e as Error).message}`;
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "runner_error", status: "error", output: msg });
    await setTaskStatus({ ...task, status: "RUNNING" }, "FAILED", { error: msg });
    return;
  }

  const running = { ...task, status: "RUNNING" as TaskStatus };

  if (out.stopped === "budget") {
    await pauseForBudget(ws.id, emp.id, "Budget reached during the run", taskId);
    await setTaskStatus(running, "QUEUED", { error: "Paused mid-run: budget cap reached. Resume after raising the budget." });
    await miscQueue.add("notify", { kind: "notify", workspaceId: ws.id, subject: msg(ws.defaultLocale, "notify.pausedMidTask", { name: emp.name }), text: task.title, link: `/tasks/${task.id}` });
    return;
  }
  if (out.stopped === "quota") {
    // interrupted by the subscription limit: resumable (same session in Workspace mode), resumes after the reset
    const until = out.quotaResetsAt ?? new Date(Date.now() + 3_600_000);
    await setTaskStatus(running, "QUEUED", { error: `Interrupted by the Claude subscription limit; resumes automatically at ${until.toISOString()}.` });
    await enqueueTask(task.id, ws.id, resumeNote ?? "You were interrupted by a usage limit. Continue where you left off.", Math.max(1000, until.getTime() - Date.now() + 5000));
    return;
  }
  if (out.stopped === "aborted") {
    const fresh = await getWorkspace(ws.id);
    await setTaskStatus(running, "CANCELLED", { error: fresh.killSwitch ? "Stopped by kill switch" : `Cancelled: ${out.error ?? ""}`, result: out.text || null });
    return;
  }
  if (out.stopped === "error") {
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "run_failed", status: "error", output: out.error });
    await setTaskStatus(running, "FAILED", { error: out.error ?? "Unknown error", result: out.text || null });
    await notifyFinished(task, "FAILED", out.error ?? "");
    if (task.parentTaskId) await onChildFinished(ws.id, task.parentTaskId);
    return;
  }

  // Start tasks created from this run (chat → board, delegation).
  for (const id of [...ctx.createdTaskIds, ...ctx.delegatedTaskIds]) {
    const [t] = await db.select({ phase: tasks.phase }).from(tasks).where(eq(tasks.id, id));
    if (t?.phase !== "hold") await enqueueTask(id, ws.id);
  }

  // Team lead: planning → wait for subtasks
  if (team?.role === "lead" && team.phase === "plan" && ctx.delegatedTaskIds.length > 0) {
    await db.update(tasks).set({ phase: "wait", result: out.text }).where(eq(tasks.id, task.id));
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "team_plan_delegated", output: { subtasks: ctx.delegatedTaskIds.length } });
    return; // stays RUNNING while members work
  }
  if (team?.role === "lead" && team.phase === "review" && ctx.revisionRequests.length > 0) {
    const n = await requestRevisions(ws.id, task.id, emp.id, ctx.revisionRequests);
    if (n > 0) {
      await db.update(tasks).set({ phase: "wait" }).where(eq(tasks.id, task.id));
      return;
    }
  }

  const pending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "PENDING")));
  if (pending.length > 0) {
    await setTaskStatus(running, "AWAITING_APPROVAL", { result: out.text, phase: team?.role === "lead" ? "review" : task.phase });
    return;
  }

  await setTaskStatus(running, "DONE", { result: out.text, phase: team ? "done" : task.phase });
  await notifyFinished(task, "DONE", out.text);
  if (task.parentTaskId) await onChildFinished(ws.id, task.parentTaskId);
}

export async function notifyFinished(task: Pick<Task, "workspaceId" | "id" | "title" | "parentTaskId" | "source">, status: TaskStatus, text: string): Promise<void> {
  if (task.parentTaskId || task.source === "replay") return; // only top-level tasks notify humans
  const locale = await workspaceLocale(task.workspaceId);
  await miscQueue.add("notify", {
    kind: "notify",
    workspaceId: task.workspaceId,
    subject: msg(locale, status === "DONE" ? "notify.taskFinished" : "notify.taskFailed", { title: task.title }),
    text: text.slice(0, 1500),
    link: `/tasks/${task.id}`,
  });
}
