import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { approvals, audit, clients, db, employeeDivision, employees, goals, projects, repositories, steps, tasks } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { prepareTaskRepo, syncMirror, type RepoRef } from "./workspace/git";
import type { TaskStatus } from "@wfos/shared";
import { enqueueTask, miscQueue, publish, redis } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { getWorkspace } from "../lib/settings";
import { activeQuotaPause } from "../lib/limits";
import { employeeOutputLocale } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { log } from "../lib/logger";
import { env } from "../lib/env";
import { checkBudget, checkDivisionBudget, msUntilNextBudgetDay, pauseForBudget, startOfUtcDay } from "../guards/budget";
import { grantedToolNames, unreadMessagesFor, type RunContext } from "../tools/registry";
import { buildSystemPrompt, inboxSection, memoryNotesBlock, recallMemories, recentWorkBrief, taintFromStoredInput, workspaceDirectory } from "./prompt";
import { MissingCredentialError, WorkspaceBusyError, runAgent } from "./executor";
import { dependencyContext, dependencyStateOf, onChildFinished, planPrompt, requestRevisions, resolveExecutor, reviewPrompt, unresolvedSubtasks } from "../orchestration/team";
import { DEPENDENCY_PHASES, PHASE_AFTER, PHASE_BLOCKED } from "../orchestration/phases";
import { runDivision } from "./division";
import { failTask, setTaskStatus } from "./task-status";
import { afterApprovalResolved, previewOutstanding } from "./approvals";
import { applyRecoveries } from "./incidents";
import { persistRunTaint, untrustedLineage } from "./taint";
import { errorMessage } from "../lib/errors";
import { scriptedTaskRun } from "../simulation/demo";
import { loadAssignedSkills } from "./skills";
import { repoRef, unmergedWorkNote } from "./merge-scan";
import { appTestContext, appTestPrompt } from "../qa/app-test";
import { appDocContext, appDocPrompt } from "../docs/app-docs";
import { appModuleContext, appModulePrompt } from "../docs/app-module";
import { uiTemplateContext, uiTemplatePrompt } from "../docs/ui-template";
import { hrReviewContext, hrReviewPrompt } from "../hr/review";
import { skillAuditContext, skillAuditPrompt } from "../hr/skill-catalog";
import { closeBrowserSession } from "../qa/browser";

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

/** P4: what an ask-only or plan-only task expects (the gate refuses every irreversible action either way) */
export function workModeNote(mode: Task["workMode"]): string {
  return mode === "ask"
    ? "## This task is answer-only\nAnswer the question with what you know and can look up. Take no actions (no emails, pushes, releases, payments or other changes outside your answer): they are refused in this task. If an action is needed, say which one and why."
    : "## This task is plan-only\nWrite a plan, do not carry it out: the steps in order, who does each (division or employee), what each needs, the risks and how to check the result. Actions are refused in this task. Deliver the plan as a document (draft_document) or in your answer.";
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
  if (task.goalId) {
    // P1: the goal the work serves, with the broader goal above it (data written by the team)
    const [g] = await db.select({ title: goals.title, description: goals.description, parentId: goals.parentId }).from(goals).where(eq(goals.id, task.goalId));
    const [up] = g?.parentId ? await db.select({ title: goals.title }).from(goals).where(eq(goals.id, g.parentId)) : [];
    if (g) parts.push(`This work serves the goal "${g.title}"${up ? ` (part of "${up.title}")` : ""}${g.description ? `: ${g.description.slice(0, 600)}` : ""}. Keep the result aligned with it.`);
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
  // an ordered subtask starts only once every sibling it waits for is DONE (onChildFinished enqueues it then)
  if (task.status === "QUEUED" && task.parentTaskId && task.dependsOn.length) {
    const state = await dependencyStateOf(task);
    if (state === "waiting" || state === "blocked") {
      const phase = state === "blocked" ? PHASE_BLOCKED : PHASE_AFTER;
      if (task.phase !== phase) await db.update(tasks).set({ phase }).where(and(eq(tasks.id, task.id), eq(tasks.status, "QUEUED")));
      log.info({ taskId, state }, "subtask waits for its dependencies; not started");
      // blocked: the parent may now have nothing left to wait for
      if (state === "blocked") await onChildFinished(task.workspaceId, task.parentTaskId);
      return;
    }
    if (task.phase && DEPENDENCY_PHASES.includes(task.phase)) {
      await db.update(tasks).set({ phase: null }).where(and(eq(tasks.id, task.id), eq(tasks.status, "QUEUED")));
      task.phase = null;
    }
  }
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

  // the division's daily budget (teams.daily_budget) across its members: the run is held until the next budget day
  const div = await employeeDivision(emp.id);
  const divBudget = div ? await checkDivisionBudget(div.division) : null;
  if (div && divBudget && !divBudget.ok) {
    await holdForDivisionBudget(task, ws, emp, div.division, divBudget.reason!, resumeNote);
    return;
  }
  const divisionLimited = !!divBudget && divBudget.remaining < budget.remaining;

  if (!(await setTaskStatus(task, "RUNNING", { error: null }))) {
    log.info({ taskId }, "task changed before the run started (cancelled, or another job took it); skipping");
    return;
  }
  const stopHeartbeat = startRunHeartbeat(task.id);
  try {
    const limit = divisionLimited ? { credits: divBudget!.remaining, division: div!.division } : { credits: budget.remaining, division: null };
    await runStarted({ ...task, status: "RUNNING" }, ws, emp, team, limit, resumeNote);
  } catch (e) {
    // Anything unexpected after RUNNING fails the task now: a BullMQ retry would only see RUNNING and skip it.
    log.error({ err: e, taskId }, "task run threw");
    await failTask(task, `Runner error: ${errorMessage(e)}`, { kind: "error", onlyIfStatus: ["RUNNING"], step: true, stepName: "runner_error", employeeId: emp.id });
  } finally {
    stopHeartbeat();
  }
}

/**
 * The division spent its daily budget: the task stays QUEUED (error "Paused: ...") and is tried again after the next
 * budget day starts. The division is not paused (its members' other work is held the same way, run by run); the
 * owners are told once per division and day, like an employee reaching its cap.
 */
async function holdForDivisionBudget(
  task: Task,
  ws: { id: string; defaultLocale: Parameters<typeof msg>[0] },
  emp: { id: string },
  division: { id: string; name: string },
  reason: string,
  resumeNote?: string,
): Promise<void> {
  await db.update(tasks).set({ error: `Paused: ${reason}` }).where(eq(tasks.id, task.id));
  await recordStep({ workspaceId: ws.id, taskId: task.id, employeeId: emp.id, kind: "budget", name: "division_budget_cap", status: "blocked", output: { reason, divisionId: division.id } });
  await enqueueTask(task.id, ws.id, resumeNote, msUntilNextBudgetDay());
  const day = startOfUtcDay().toISOString().slice(0, 10);
  const first = await redis.set(`wfos:div-budget:${division.id}:${day}`, "1", "EX", 2 * 86_400, "NX").catch(() => null);
  if (first) {
    await audit({ workspaceId: ws.id, actorLabel: "system", action: "division.paused_budget", targetType: "team", targetId: division.id, details: { reason } });
    await publish(ws.id, { type: "task.updated", taskId: task.id, status: "QUEUED" });
    await miscQueue.add("notify", {
      kind: "notify",
      notificationKind: "limits",
      employeeId: emp.id,
      workspaceId: ws.id,
      subject: msg(ws.defaultLocale, "notify.pausedBudget", { name: division.name }),
      text: reason,
      link: `/tasks/${task.id}`,
    });
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
async function runStarted(
  task: Task,
  ws: Workspace,
  emp: Employee,
  team: Team,
  /** credits this run may spend; division: the division's daily budget is the tighter limit */
  limit: { credits: number; division: { id: string; name: string } | null },
  resumeNote?: string,
): Promise<void> {
  const taskId = task.id;
  const creditBudget = limit.credits;
  // Workspace mode (not for a head planning or reviewing: that is platform work), with a repository: refresh the
  // platform mirror, then clone/refresh inside the sandbox. A member's subtask (the code lead's build) runs in it too.
  // an ask-only or plan-only task (P4) changes nothing: no sandbox
  const workspaceMode = emp.executionMode === "workspace" && team?.role !== "lead" && task.workMode === "standard";
  // sandbox time across all of this task's runs, counted from the last time a person let it go on
  const sandboxLimitSec = env.workspaceTaskMaxHours * 3600;
  const sandboxUsedSec = Math.max(0, task.sandboxSeconds - task.sandboxSecondsBase);
  if (workspaceMode && sandboxUsedSec >= sandboxLimitSec) {
    await failTask(task, timeLimitMessage(), { kind: "time_limit", step: true, stepName: "run_time_limit", employeeId: emp.id });
    return;
  }
  let repository: (RepoRef & { name: string }) | undefined;
  if (workspaceMode && task.repositoryId) {
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

  // C3: an app test task drives the preview's browser (tools granted by ctx.appTest)
  const appTest = await appTestContext(task.id);
  // C9: a task asked to write an app document gets save_app_document for that app and kind
  const appDoc = await appDocContext(task.id);
  // C8: a build or change of an app module (or a subtask of one) gets the module's PRD and the other modules
  const appModule = await appModuleContext(task);
  // C5: the look of the app this work is on (its UI template and Figma file)
  const uiTemplate = await uiTemplateContext(task, appModule?.appId ?? appDoc?.appId);
  // C2: an HR review task gets submit_hr_review for its employee
  const hrReview = await hrReviewContext(task.id);
  // C4: a skill audit task gets the team's roster and the catalog tools
  const skillAudit = await skillAuditContext(task.id);
  const lang = employeeOutputLocale(emp.outputLanguage, ws.defaultLocale) ?? "en";
  const division = await runDivision(emp, ws, lang, { workspaceMode });

  const ctx: RunContext = {
    runId: randomUUID(),
    workspaceId: ws.id,
    employee: { id: emp.id, name: emp.name, role: emp.role, autonomyLevel: emp.autonomyLevel, toolPermissions: emp.toolPermissions, allowList: emp.allowList },
    taskId: task.id,
    conversationId: null,
    dryRun: task.dryRun,
    workMode: task.workMode,
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
    division: division.context,
    // client isolation: knowledge, memory, recent work and client lookups of this client (plus general ones) only
    clientId: task.clientId,
    ...(appTest ? { appTest } : {}),
    ...(appDoc ? { appDoc } : {}),
    ...(appModule ? { appModule } : {}),
    ...(hrReview ? { hrReview } : {}),
    ...(skillAudit ? { skillAudit } : {}),
    ...(workspaceMode
      ? {
          workspace: {
            egressDomains: emp.egressDomains,
            // follow-ups on the same task resume the same Claude session in the same workspace
            resume: task.agentSessionId ?? undefined,
            onSession: async (sessionId: string) => {
              await db.update(tasks).set({ agentSessionId: sessionId, workspaceStatus: "active" }).where(eq(tasks.id, task.id));
            },
            repository,
            timeLeftMs: (sandboxLimitSec - sandboxUsedSec) * 1000,
            // approval tiers: the division's AI lead reviews a non-local command before the owner does
            review: { own: division.reviewers?.own ?? null, subagents: division.reviewers?.subagents ?? null, task: { title: task.title, brief: task.brief } },
          },
        }
      : {}),
  };

  const [mem, directory, context, inbox, recent, assignedSkills] = await Promise.all([
    recallMemories(emp.id, `${task.title}\n${task.brief}`, task.clientId),
    workspaceDirectory(ws.id),
    taskContext(task),
    unreadMessagesFor(emp.id, task.clientId),
    recentWorkBrief(emp.id, { excludeTaskId: task.id, clientId: task.clientId }).catch((e: unknown) => (log.warn({ err: e, taskId }, "recent work brief failed"), "")),
    loadAssignedSkills(emp.id, ws.id, ctx.employee.toolPermissions),
  ]);
  // listed in the system prompt; skill_read is granted implicitly while there is one. Workspace mode: the runner
  // writes the TRUSTED ones as SKILL.md files each run; untrusted skills are reachable only via skill_read (which taints)
  ctx.skills = assignedSkills;

  // stored content written by a tainted run (or imported) is fenced as data in the prompt and taints this run
  await taintFromStoredInput(ctx, mem, inbox);
  // which memories this run got (the Activity shows them, with a link to each)
  if (mem.length) {
    await recordStep({
      workspaceId: ws.id,
      taskId: task.id,
      employeeId: emp.id,
      kind: "system",
      name: "memory_recall",
      output: { memories: mem.flatMap((m) => (m.id ? [{ id: m.id, kind: m.kind ?? "fact", excerpt: m.content.slice(0, 160) }] : [])) },
    }).catch((e: unknown) => log.warn({ err: e, taskId }, "memory_recall step not recorded"));
  }

  // memories and recent work lead the user message (data, not instructions): the system prompt stays stable across runs
  const promptParts = [memoryNotesBlock(mem), `# Task: ${task.title}`, task.brief, context && `## Context\n${context}`, await dependencyContext(task), recent];
  // a first run on a repository (the head planning, or the build): earlier tasks' pushed work the checkout lacks
  if (task.repositoryId && !resumeNote && !task.agentSessionId && !(team?.role === "lead" && team.phase === "review")) {
    const ref = repository ?? (await repoRef(ws.id, task.repositoryId).catch(() => null));
    if (ref) promptParts.push(await unmergedWorkNote(ws.id, ref, task.id));
  }
  if (inbox.length) promptParts.push(inboxSection(inbox));
  if (appTest) promptParts.push(appTestPrompt(appTest));
  if (appDoc) promptParts.push(appDocPrompt(appDoc));
  if (appModule) promptParts.push(appModulePrompt(appModule));
  if (uiTemplate) promptParts.push(uiTemplatePrompt(uiTemplate, { builds: workspaceMode && !!task.repositoryId }));
  if (hrReview) promptParts.push(hrReviewPrompt(hrReview));
  if (skillAudit) promptParts.push(skillAuditPrompt(skillAudit));
  if (team?.role === "lead" && team.phase === "plan") promptParts.push(await planPrompt(team));
  if (team?.role === "lead" && team.phase === "review") promptParts.push(await reviewPrompt(task));
  if (task.workMode !== "standard") promptParts.push(workModeNote(task.workMode));
  if (resumeNote) promptParts.push(`## Update since your last attempt\n${resumeNote}`);
  if (task.deliverables.length && !(team?.role === "lead" && team.phase === "review")) {
    promptParts.push(`## Your previous deliverables on this task\n${task.deliverables.map((d) => `- ${d.title} (${d.kind})`).join("\n")}`);
  }

  // the code lead's subagents (Workspace mode): the division's members with role "subagent", from their own profiles
  const agents = ctx.workspace ? division.agents : undefined;

  const systemPrompt = buildSystemPrompt({
    employee: emp,
    workspaceName: ws.name,
    directory,
    grantedTools: grantedToolNames(ctx).map((n) => n.split("__").pop()!),
    dryRun: task.dryRun,
    mode: "task",
    workspace: ctx.workspace ? { egressDomains: ctx.workspace.egressDomains, hasRepository: !!task.repositoryId } : undefined,
    division: division.prompt,
    outputLocale: employeeOutputLocale(emp.outputLanguage, ws.defaultLocale),
    skills: assignedSkills,
  });

  let out;
  const runStartedAt = Date.now();
  try {
    out = await runAgent({ ctx, model: emp.model, systemPrompt, prompt: promptParts.filter(Boolean).join("\n\n"), creditBudget, agents, agentEmployees: agents ? division.agentEmployees : undefined });
  } catch (e) {
    await persistRunTaint(ctx.guard, task);
    if (e instanceof WorkspaceBusyError) {
      // not a failure: wait for a free sandbox slot (recorded once, not on every retry)
      if (!(await setTaskStatus({ ...task, status: "RUNNING" }, "QUEUED", { error: null }))) return; // cancelled meanwhile
      if (e.firstWait) await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "workspace_slot_busy", status: "waiting", output: { reason: e.reason } });
      await enqueueTask(task.id, ws.id, resumeNote, 15_000);
      return;
    }
    if (workspaceMode) await addSandboxTime(task.id, Date.now() - runStartedAt);
    if (appTest) await closeBrowserSession(appTest.testId);
    const msg = e instanceof MissingCredentialError ? e.message : `Runner error: ${errorMessage(e)}`;
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: "runner_error", status: "error", output: msg });
    await failTask(task, msg, { kind: "error" });
    return;
  }

  // however the run ended or paused (done, approval, waiting for subtasks, any stop): before the status change
  await persistRunTaint(ctx.guard, task);
  if (workspaceMode) await addSandboxTime(task.id, Date.now() - runStartedAt);
  // the browser of an app test lives for one run (a later run signs in again)
  if (appTest) await closeBrowserSession(appTest.testId);

  const running = { ...task, status: "RUNNING" as TaskStatus };

  if (out.stopped === "budget" && limit.division) {
    // the division's daily budget ran out mid-run: held like a division run that could not start (resumable)
    if (!(await setTaskStatus(running, "QUEUED", { error: null }))) return;
    await holdForDivisionBudget(task, ws, emp, limit.division, "Division daily budget reached during the run", resumeNote ?? "You were paused by the division's daily budget. Continue where you left off.");
    return;
  }
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
  if (out.stopped === "yield") {
    // handed the sandbox to a waiting task: not a failure, the same session resumes after it got its turn
    if (!(await setTaskStatus(running, "QUEUED", { error: null }))) return;
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "workspace_yielded", status: "waiting" });
    await enqueueTask(task.id, ws.id, resumeNote ?? YIELD_NOTE, YIELD_DELAY_MS);
    return;
  }
  if (out.stopped === "time_limit") {
    await failTask(task, out.error ?? timeLimitMessage(), { kind: "time_limit", step: true, stepName: "run_time_limit", employeeId: emp.id, result: out.text || null });
    return;
  }
  if (out.stopped === "aborted") {
    const fresh = await getWorkspace(ws.id);
    await setTaskStatus(running, "CANCELLED", { error: fresh.killSwitch ? "Stopped by kill switch" : `Cancelled: ${out.error ?? ""}`, result: out.text || null });
    return;
  }
  if (out.stopped === "error") {
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "error", name: out.errorKind ? `run_${out.errorKind}` : "run_failed", status: "error", output: out.error });
    // out_of_memory: its own incident kind, so the head and the owner see that a retry needs more memory or lighter steps
    await failTask(task, out.error ?? "Unknown error", { kind: out.errorKind === "out_of_memory" ? "out_of_memory" : "error", result: out.text || null });
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
  // A subtask that waits for others (phase after) is started by onChildFinished once they are DONE.
  for (const id of [...ctx.createdTaskIds, ...ctx.delegatedTaskIds]) {
    const [t] = await db.select({ phase: tasks.phase }).from(tasks).where(eq(tasks.id, id));
    if (t && t.phase !== "hold" && !(t.phase && DEPENDENCY_PHASES.includes(t.phase))) await enqueueTask(id, ws.id);
  }

  // Team lead: planning → wait for subtasks
  if (team?.role === "lead" && team.phase === "plan" && ctx.delegatedTaskIds.length > 0) {
    await db.update(tasks).set({ phase: "wait", result: out.text }).where(eq(tasks.id, task.id));
    await recordStep({ workspaceId: ws.id, taskId, employeeId: emp.id, kind: "system", name: "team_plan_delegated", output: { subtasks: ctx.delegatedTaskIds.length } });
    return; // stays RUNNING while members work
  }
  let revisionsUnapplied = false;
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
    revisionsUnapplied = ctx.revisionRequests.length > 0;
  }
  if (team?.role === "lead" && team.phase === "review" && (await reviewOutcome(running, ws.id, emp.id, ctx, out.text, revisionsUnapplied)) === "handled") return;

  const pending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "PENDING")));
  if (pending.length > 0) {
    await setTaskStatus(running, "AWAITING_APPROVAL", { result: out.text, phase: leadPhaseAfterRun(team, task.phase) });
    return;
  }
  // a preview approved while the run went on is still being deployed (or came back failed): the task waits for the
  // platform's result instead of finishing; afterApprovalResolved decides now that the run is over
  if (await previewOutstanding(task.id)) {
    if (await setTaskStatus(running, "AWAITING_APPROVAL", { result: out.text, phase: leadPhaseAfterRun(team, task.phase) })) await afterApprovalResolved(task.id);
    return;
  }

  // DONE wakes the parent, settles the routine run, publishes and notifies (afterTerminal)
  await setTaskStatus(running, "DONE", { result: out.text, phase: team ? "done" : task.phase });
}

/**
 * A head's review that wanted changes, or that left a failed subtask unresolved, but ended without a verdict is sent
 * back to the head this many times, then fails.
 */
export const REVIEW_NO_VERDICT_RETRIES = 1;

/**
 * The end of a head's review run when nothing was sent back. finish_review "fail" fails the task with the head's notes
 * (an incident tells a person). A review that wanted changes (a refused request_revision, or a revision that could not
 * be applied) but gave no verdict must not finish as DONE: the head gets the review back once with its options, then
 * the task fails. The same holds for a review that ends while a subtask is FAILED (or blocked by a failed one) and
 * nothing was retried or reassigned: a failed build must never let the parent end DONE without the head's "accept".
 * Otherwise ("accept", or a plain review of finished work) the run finishes as usual below.
 */
async function reviewOutcome(
  running: Task,
  workspaceId: string,
  employeeId: string,
  ctx: RunContext,
  text: string,
  revisionsUnapplied: boolean,
): Promise<"handled" | "finish"> {
  const verdict = ctx.reviewVerdict;
  if (verdict?.outcome === "fail") {
    await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_failed", status: "error", output: { notes: verdict.notes } });
    await failTask(running, `The division head did not accept the work: ${verdict.notes}`, { kind: "error", result: text || verdict.notes, onlyIfStatus: ["RUNNING"] });
    return "handled";
  }
  if (verdict?.outcome === "accept") {
    await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_accepted", output: { notes: verdict.notes } });
    return "finish";
  }
  if (!revisionsUnapplied && !(ctx.refusedRevisions ?? 0)) {
    const unresolved = await unresolvedSubtasks(running.id);
    if (!unresolved.length) return "finish";
    return unresolvedReview(running, workspaceId, employeeId, text, unresolved);
  }
  const [{ n = 0 } = {}] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(steps)
    .where(and(eq(steps.taskId, running.id), eq(steps.name, "team_review_no_verdict")));
  const reason = revisionsUnapplied
    ? "a revision you requested could not be applied (the subtask had no revision left or was no longer DONE)"
    : "request_revision was refused";
  if (Number(n) >= REVIEW_NO_VERDICT_RETRIES) {
    await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_no_verdict", status: "error", output: { reason, final: true } });
    await failTask(running, `The review ended without a verdict: the division head wanted changes (${reason}) but neither accepted nor failed the work.`, {
      kind: "error",
      result: text || null,
      onlyIfStatus: ["RUNNING"],
    });
    return "handled";
  }
  await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_no_verdict", status: "flagged", output: { reason } });
  await db.update(tasks).set({ phase: "review", result: text || null }).where(and(eq(tasks.id, running.id), eq(tasks.status, "RUNNING")));
  await enqueueTask(
    running.id,
    workspaceId,
    `Your last review run ended without a verdict although you wanted changes: ${reason}. ` +
      'The work cannot be sent back again. Decide now with finish_review: outcome "accept" if the result is usable (notes: what is missing or should follow up), ' +
      'or outcome "fail" (notes: exactly what is missing against the acceptance criteria). Then end with your summary.',
  );
  return "handled";
}

/**
 * A review ended without a verdict while subtasks are FAILED or blocked and nothing was retried or reassigned: back
 * to the head once with its options, then the task fails (an incident tells a person). Never DONE.
 */
async function unresolvedReview(
  running: Task,
  workspaceId: string,
  employeeId: string,
  text: string,
  unresolved: { id: string; title: string; state: "FAILED" | "BLOCKED" }[],
): Promise<"handled"> {
  const list = unresolved.map((u) => `"${u.title}" (${u.id}, ${u.state === "FAILED" ? "failed" : "blocked by a failed subtask"})`).join(", ");
  const output = { subtasks: unresolved.map((u) => ({ id: u.id, title: u.title, state: u.state })) };
  const [{ n = 0 } = {}] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(steps)
    .where(and(eq(steps.taskId, running.id), eq(steps.name, "team_review_unresolved")));
  if (Number(n) >= REVIEW_NO_VERDICT_RETRIES) {
    await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_unresolved", status: "error", output: { ...output, final: true } });
    await failTask(running, `The review ended without a verdict while subtasks had failed: ${list}. Nothing was retried or reassigned and the division head did not accept the work.`, {
      kind: "error",
      result: text || null,
      onlyIfStatus: ["RUNNING"],
    });
    return "handled";
  }
  await recordStep({ workspaceId, taskId: running.id, employeeId, kind: "system", name: "team_review_unresolved", status: "flagged", output });
  await db.update(tasks).set({ phase: "review", result: text || null }).where(and(eq(tasks.id, running.id), eq(tasks.status, "RUNNING")));
  await enqueueTask(
    running.id,
    workspaceId,
    `Your last review run ended without a decision although subtasks did not finish: ${list}. The task cannot end as done this way. ` +
      "Decide now: retry_subtask or reassign_subtask while the failed subtask has retries left (blocked subtasks start once it is DONE); " +
      'otherwise finish_review with outcome "accept" only if the work is usable without it (notes: what is missing), or outcome "fail" (notes: what failed and what is needed). Then end with your summary.',
  );
  return "handled";
}

/**
 * The phase a task keeps while it waits for an approval: a head that worked in the plan phase (did the task itself, or
 * wrote a PRD) resumes planning; a head in review resumes the review; anyone else keeps the task's phase.
 */
function leadPhaseAfterRun(team: Team, phase: string | null): string | null {
  if (team?.role !== "lead") return phase;
  return team.phase === "plan" ? "plan" : "review";
}

/** A run that handed its sandbox over continues with this note (same Claude session, same workspace). */
const YIELD_NOTE =
  "You were paused so another task could use the sandbox. Continue where you left off: commands that were running were stopped, so check the state of your files and re-run what did not finish.";
/** longer than a waiting task's retry interval (15 s), so the waiting task takes the slot first */
const YIELD_DELAY_MS = 20_000;

function timeLimitMessage(): string {
  return `The task used up its sandbox time (${env.workspaceTaskMaxHours} h across its runs). A person can let it continue (retry or request changes), or split the work into smaller tasks.`;
}

/** Adds a Workspace-mode run's wall-clock time to the task (never lost to a failed update: logged instead). */
async function addSandboxTime(taskId: string, ms: number): Promise<void> {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (!sec) return;
  await db
    .update(tasks)
    .set({ sandboxSeconds: sql`${tasks.sandboxSeconds} + ${sec}` })
    .where(eq(tasks.id, taskId))
    .catch((e: unknown) => log.error({ err: e, taskId, sec }, "sandbox time not recorded"));
}
