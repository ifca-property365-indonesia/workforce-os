import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approvals, clients, db, employees, projects, repositories, steps, tasks, workspaceDepartments } from "@wfos/db";
import { ROLE_TEMPLATES } from "@wfos/templates";
import { decryptSecret } from "@wfos/shared/server";
import { prepareTaskRepo, syncMirror, type RepoRef } from "./workspace/git";
import type { TaskStatus } from "@wfos/shared";
import { enqueueTask, miscQueue } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { getWorkspace } from "../lib/settings";
import { activeQuotaPause } from "../lib/limits";
import { employeeOutputLocale } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { log } from "../lib/logger";
import { checkBudget, pauseForBudget } from "../guards/budget";
import { grantedToolNames, unreadMessagesFor, type RunContext } from "../tools/registry";
import { buildSystemPrompt, inboxSection, memoryNotesBlock, recallMemories, recentWorkBrief, taintFromStoredInput, workspaceDirectory } from "./prompt";
import { MissingCredentialError, WorkspaceBusyError, runAgent } from "./executor";
import { planPrompt, requestRevisions, resolveExecutor, reviewPrompt } from "../orchestration/team";
import { failTask, setTaskStatus } from "./task-status";
import { afterApprovalResolved, previewOutstanding } from "./approvals";
import { applyRecoveries } from "./incidents";
import { persistRunTaint, untrustedLineage } from "./taint";
import { errorMessage } from "../lib/errors";
import { scriptedTaskRun } from "../simulation/demo";
import { loadAssignedSkills } from "./skills";

type Task = typeof tasks.$inferSelect;

// Status changes live in ./task-status (setTaskStatus, failTask); re-exported for existing importers.
export { failTask, notifyFinished, setTaskStatus } from "./task-status";
export { untrustedLineage } from "./taint";

/** While a run is in flight its row is touched this often, so the reaper (35 min) never takes it for an orphan. */
export const RUN_HEARTBEAT_MS = 5 * 60_000;

function startRunHeartbeat(taskId: string): () => void {
  const timer = setInterval(() => {
    db.update(tasks)
      .set({ updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "RUNNING")))
      .catch((e: unknown) => log.warn({ err: e, taskId }, "run heartbeat failed"));
  }, RUN_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
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
    await failTask(task, "Task has no assignee (and no team lead).", { kind: "could_not_start" });
    return;
  }
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  if (!emp) {
    await failTask(task, "Assignee not found.", { kind: "could_not_start" });
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
    await miscQueue.add("notify", { kind: "notify", notificationKind: "limits", employeeId: emp.id, workspaceId: ws.id, subject: msg(ws.defaultLocale, "notify.pausedBudget", { name: emp.name }), text: budget.reason!, link: `/employees/${emp.id}` });
    return;
  }

  if (!(await setTaskStatus(task, "RUNNING", { error: null }))) {
    log.info({ taskId }, "task changed before the run started (cancelled, or another job took it); skipping");
    return;
  }
  const stopHeartbeat = startRunHeartbeat(task.id);
  try {
    await runStarted({ ...task, status: "RUNNING" }, ws, emp, team, budget.remaining, resumeNote);
  } catch (e) {
    // Anything unexpected after RUNNING fails the task now: a BullMQ retry would only see RUNNING and skip it.
    log.error({ err: e, taskId }, "task run threw");
    await failTask(task, `Runner error: ${errorMessage(e)}`, { kind: "error", onlyIfStatus: ["RUNNING"], step: true, stepName: "runner_error", employeeId: emp.id });
  } finally {
    stopHeartbeat();
  }
}

const UNTRUSTED_INPUT_NOTE = "Created from untrusted input (e.g. a webhook payload), or an earlier run of it handled untrusted content: every irreversible action in this run needs human approval.";
const UNTRUSTED_SUBTASK_NOTE = "A subtask was created from or handled untrusted content: every irreversible action in this run needs human approval.";

/** One guard step of this name per task (not per run), so the timeline says why approvals are forced. */
async function recordTaskTaint(task: Task, employeeId: string, name: "untrusted_input" | "untrusted_subtask", note: string, input?: Record<string, unknown>): Promise<void> {
  try {
    const [seen] = await db.select({ id: steps.id }).from(steps).where(and(eq(steps.taskId, task.id), eq(steps.kind, "guard"), eq(steps.name, name))).limit(1);
    if (seen) return;
    await recordStep({ workspaceId: task.workspaceId, taskId: task.id, employeeId, kind: "guard", name, status: "flagged", ...(input ? { input } : {}), output: { note } });
  } catch (e) {
    log.warn({ err: e, taskId: task.id, name }, "taint step not recorded"); // the taint stands
  }
}

/** Team lead (plan or review): ids of its subtasks marked untrusted (created from, or a run of them handled, untrusted content). */
async function untrustedSubtaskIds(taskId: string): Promise<string[]> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentTaskId, taskId), eq(tasks.untrustedInput, true)));
  return rows.map((r) => r.id);
}

type Workspace = Awaited<ReturnType<typeof getWorkspace>>;
type Employee = typeof employees.$inferSelect;
type Team = Awaited<ReturnType<typeof resolveExecutor>>["team"];

/** The run proper, entered with the task RUNNING. */
async function runStarted(task: Task, ws: Workspace, emp: Employee, team: Team, creditBudget: number, resumeNote?: string): Promise<void> {
  const taskId = task.id;
  // Workspace mode with a repository: refresh the platform mirror, then clone/refresh inside the sandbox
  let repository: (RepoRef & { name: string }) | undefined;
  if (emp.executionMode === "workspace" && !team && task.repositoryId) {
    const [r] = await db.select().from(repositories).where(and(eq(repositories.id, task.repositoryId), eq(repositories.workspaceId, ws.id)));
    if (!r) {
      await failTask(task, "The task's repository no longer exists.", { kind: "could_not_start" });
      return;
    }
    repository = { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, token: r.tokenEnc ? decryptSecret(r.tokenEnc) : null };
    try {
      await syncMirror(repository);
      await prepareTaskRepo({ workspaceId: ws.id, taskId: task.id, repo: repository });
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "repository_prepared", output: { repository: r.name, branch: `agent/${task.id}` } });
    } catch (e) {
      const msg = `Could not prepare repository ${r.name}: ${errorMessage(e)}`.replace(/Authorization: [^\s]+ [^\s]+/g, "Authorization: ***");
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "repository_failed", status: "error", output: msg });
      await failTask(task, msg, { kind: "could_not_start" });
      return;
    }
  }

  const untrusted = await untrustedLineage(task);
  if (untrusted) await recordTaskTaint(task, emp.id, "untrusted_input", UNTRUSTED_INPUT_NOTE);
  // a lead reads its subtasks' results and deliverables (review) or re-plans around them: one untrusted subtask taints it
  const untrustedKids = team?.role === "lead" ? await untrustedSubtaskIds(task.id) : [];
  if (untrustedKids.length) await recordTaskTaint(task, emp.id, "untrusted_subtask", UNTRUSTED_SUBTASK_NOTE, { taskIds: untrustedKids });

  const ctx: RunContext = {
    runId: randomUUID(),
    workspaceId: ws.id,
    employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
    taskId: task.id,
    conversationId: null,
    dryRun: task.dryRun,
    sandboxed: false,
    // created from untrusted input (a webhook payload, or a sub-/follow-up task of one): the run starts tainted,
    // so every irreversible action needs a human approval, even an allow-listed one (applyRunSignals)
    guard: { workspaceId: ws.id, taskId: task.id, conversationId: null, employeeId: emp.id, enabled: ws.guardsEnabled, tainted: untrusted || untrustedKids.length > 0 },
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

  const [mem, directory, context, inbox, recent, assignedSkills] = await Promise.all([
    recallMemories(emp.id, `${task.title}\n${task.brief}`),
    workspaceDirectory(ws.id),
    taskContext(task),
    unreadMessagesFor(emp.id),
    recentWorkBrief(emp.id, { excludeTaskId: task.id }).catch((e: unknown) => (log.warn({ err: e, taskId }, "recent work brief failed"), "")),
    loadAssignedSkills(emp.id, ws.id, ctx.employee.toolPermissions),
  ]);
  // listed in the system prompt; skill_read is granted implicitly while there is one. Workspace mode: the runner
  // writes the TRUSTED ones as SKILL.md files each run; untrusted skills are reachable only via skill_read (which taints)
  ctx.skills = assignedSkills;

  // stored content written by a tainted run (or imported) is fenced as data in the prompt and taints this run
  await taintFromStoredInput(ctx, mem, inbox);

  // memories and recent work lead the user message (data, not instructions): the system prompt stays stable across runs
  const promptParts = [memoryNotesBlock(mem), `# Task: ${task.title}`, task.brief, context && `## Context\n${context}`, recent];
  if (inbox.length) promptParts.push(inboxSection(inbox));
  if (team?.role === "lead" && team.phase === "plan") promptParts.push(await planPrompt(team));
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
    directory,
    grantedTools: grantedToolNames(ctx).map((n) => n.split("__").pop()!),
    dryRun: task.dryRun,
    mode: "task",
    workspace: ctx.workspace ? { egressDomains: ctx.workspace.egressDomains, hasRepository: !!task.repositoryId } : undefined,
    department: dept ? { name: dept.name[lang], sop: dept.sop[lang], subagents: agents ? Object.keys(agents) : [] } : undefined,
    outputLocale: employeeOutputLocale(emp.outputLanguage, ws.defaultLocale),
    skills: assignedSkills,
  });

  let out;
  try {
    out = await runAgent({ ctx, model: emp.model, systemPrompt, prompt: promptParts.filter(Boolean).join("\n\n"), creditBudget, agents });
  } catch (e) {
    await persistRunTaint(ctx.guard, task);
    if (e instanceof WorkspaceBusyError) {
      // not a failure: wait for a free sandbox slot
      if (!(await setTaskStatus({ ...task, status: "RUNNING" }, "QUEUED", { error: null }))) return; // cancelled meanwhile
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "workspace_slot_busy", status: "waiting" });
      await enqueueTask(task.id, ws.id, resumeNote, 15_000);
      return;
    }
    const msg = e instanceof MissingCredentialError ? e.message : `Runner error: ${errorMessage(e)}`;
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "runner_error", status: "error", output: msg });
    await failTask(task, msg, { kind: "error" });
    return;
  }

  // however the run ended or paused (done, approval, waiting for subtasks, any stop): before the status change
  await persistRunTaint(ctx.guard, task);

  const running = { ...task, status: "RUNNING" as TaskStatus };

  if (out.stopped === "budget") {
    await pauseForBudget(ws.id, emp.id, "Budget reached during the run", taskId);
    if (!(await setTaskStatus(running, "QUEUED", { error: "Paused mid-run: budget cap reached. Resume after raising the budget." }))) return;
    await miscQueue.add("notify", { kind: "notify", notificationKind: "limits", employeeId: emp.id, workspaceId: ws.id, subject: msg(ws.defaultLocale, "notify.pausedMidTask", { name: emp.name }), text: task.title, link: `/tasks/${task.id}` });
    return;
  }
  if (out.stopped === "quota") {
    // interrupted by the subscription limit: resumable (same session in Workspace mode), resumes after the reset
    const until = out.quotaResetsAt ?? new Date(Date.now() + 3_600_000);
    if (!(await setTaskStatus(running, "QUEUED", { error: `Interrupted by the Claude subscription limit; resumes automatically at ${until.toISOString()}.` }))) return;
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
    await failTask(task, out.error ?? "Unknown error", { kind: "error", result: out.text || null });
    return;
  }
  if (out.stopped === "stalled" || out.stopped === "loop") {
    // stopped by the executor's watchdogs: an incident of that kind (the lead or a person handles it)
    const error = out.error ?? (out.stopped === "stalled" ? "The run stalled: no progress for too long." : "The run was stopped: the same tool call kept repeating.");
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: `run_${out.stopped}`, status: "error", output: error });
    await failTask(task, error, { kind: out.stopped, result: out.text || null });
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
  if (team?.role === "lead" && team.phase === "review" && (ctx.revisionRequests.length > 0 || (ctx.recoveryRequests?.length ?? 0) > 0)) {
    // wait first: a subtask re-queued below that finishes fast must find the parent waiting (onChildFinished)
    await db.update(tasks).set({ phase: "wait" }).where(eq(tasks.id, task.id));
    // neither may strand the parent in "wait": a failure counts as nothing re-queued (applyRecoveries never throws)
    const n = ctx.revisionRequests.length
      ? await requestRevisions(ws.id, task.id, emp.id, ctx.revisionRequests, { untrusted: ctx.guard.tainted }).catch((e: unknown) => (log.error({ err: e, taskId }, "revisions not applied"), 0))
      : 0;
    const m = await applyRecoveries(ws.id, task.id, emp.id, ctx.recoveryRequests ?? [], { untrusted: ctx.guard.tainted });
    if (n + m > 0) {
      await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "team_review_reopened", output: { revisions: n, recoveries: m } });
      return; // stays RUNNING; the review runs again once these subtasks end
    }
    await db.update(tasks).set({ phase: "review" }).where(eq(tasks.id, task.id)); // nothing re-queued: finish below
  }

  const pending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "PENDING")));
  if (pending.length > 0) {
    await setTaskStatus(running, "AWAITING_APPROVAL", { result: out.text, phase: team?.role === "lead" ? "review" : task.phase });
    return;
  }
  // a preview approved while the run went on is still being deployed (or came back failed): the task waits for the
  // platform's result instead of finishing; afterApprovalResolved decides now that the run is over
  if (await previewOutstanding(task.id)) {
    if (await setTaskStatus(running, "AWAITING_APPROVAL", { result: out.text, phase: team?.role === "lead" ? "review" : task.phase })) await afterApprovalResolved(task.id);
    return;
  }

  // DONE wakes the parent, settles the routine run, publishes and notifies (afterTerminal)
  await setTaskStatus(running, "DONE", { result: out.text, phase: team ? "done" : task.phase });
}
