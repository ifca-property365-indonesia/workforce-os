import { approvals, audit, createTask, db, employees, employeeSkills, repositories, routines, skills, TaskInputError, tasks, teams, users, withEmployeeRevision, type TaskRow } from "@wfos/db";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { enqueueTask, publish } from "../lib/redis";
import { agentBranch, createPullRequest, mergeAgentBranch, pushAgentBranch, type ProviderFetch, type RepoRef } from "../runner/workspace/git";
import { runApprovedCommand } from "../runner/workspace/exec";
import { queuePreviewRelease } from "../deploy/preview";
import { queueLiveRelease } from "../deploy/live-request";
import { emailPayloadSchema, invoicePayloadSchema, ROUTINE_OVERLAP_MODES, routineInputSchema, TERMINAL_STATUSES, webhookPayloadSchema, type OutboundEmailTrigger } from "@wfos/shared";
import { decryptSecret, screenLeakage, withRetry } from "@wfos/shared/server";
import { msg } from "@wfos/shared/messages";
import { and, desc, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getExternalMcpServers, getWebhookUrl, workspaceLocale } from "../lib/settings";
import { sendEmailPayload, sendInvoicePayload } from "../lib/outbox";
import { isReservedSkillSlug, skillProposalSchema, skillProvenanceHash, SKILL_SLUG_MAX } from "../runner/skills";
import { doInstallSkill } from "../hr/skill-catalog";

export interface ActionResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

async function doPostWebhook(workspaceId: string, p: { channel: string; text: string }): Promise<ActionResult> {
  const url = await getWebhookUrl(workspaceId);
  if (!url) return { ok: false, summary: "No webhook configured (Settings → Notifications)." };
  const res = await withRetry(
    async (signal) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: p.text, channel: p.channel }),
        signal,
      });
      if (r.status >= 500) throw new Error(`webhook ${r.status}`);
      return r;
    },
    { retries: 2, timeoutMs: 10000, label: "webhook" },
  );
  return { ok: res.ok, summary: res.ok ? "Published to webhook" : `Webhook responded ${res.status}` };
}

/** Workspace mode: run the exact approved command in the task's sandbox. A non-zero exit is a result, not a platform failure. */
async function doRunApprovedCommand(workspaceId: string, command: string, context: { taskId?: string | null; employeeId?: string | null }): Promise<ActionResult> {
  if (!command || !context.taskId || !context.employeeId) return { ok: false, summary: "Approved command has no task workspace" };
  const [emp] = await db.select({ egress: employees.egressDomains, mode: employees.executionMode }).from(employees).where(eq(employees.id, context.employeeId));
  if (emp?.mode !== "workspace") return { ok: false, summary: "The employee is no longer in Workspace mode" };
  const r = await runApprovedCommand({ workspaceId, taskId: context.taskId, command, egressAllow: emp.egress });
  const status = r.timedOut ? "timed out" : `exit code ${r.exitCode}`;
  return {
    ok: true,
    summary: `Ran in the workspace (${status}), git hooks disabled`,
    details: { exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, output: r.output },
  };
}

/**
 * Approved PRD → the build. teamId (the division that builds it; Edit & Approve may change it) must belong to the
 * workspace and have a head. When the PRD was written by the head of a still-open division task of that division
 * (resumeTaskId = the approval's own task), that task resumes in the plan phase with the PRD (afterApprovalResolved
 * does it, seeing details.resumedTaskId); otherwise a new division-level task carries the PRD (originTaskId = the PRD
 * task). Approvals made before divisions carry developerId instead: the task goes to that employee while they exist.
 */
async function doHandoffPrd(workspaceId: string, p: Record<string, unknown>, context: { taskId?: string | null; untrusted?: boolean }): Promise<ActionResult> {
  const teamId = typeof p.teamId === "string" && p.teamId ? p.teamId : null;
  const developerId = typeof p.developerId === "string" && p.developerId ? p.developerId : null;
  const title = String(p.title ?? "PRD").slice(0, 180);
  let team: { id: string; name: string; leadId: string | null } | undefined;
  if (teamId) {
    [team] = UUID_RE.test(teamId) ? await db.select({ id: teams.id, name: teams.name, leadId: teams.leadId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId))) : [];
    if (!team) return { ok: false, summary: "The chosen division does not exist in this workspace." };
    if (!team.leadId) return { ok: false, summary: `${team.name} has no head to take the work: choose another division (Edit & Approve) or set its head first.` };
    // the head's own division task goes on with the PRD instead of a new task
    const resumeTaskId = typeof p.resumeTaskId === "string" ? p.resumeTaskId : null;
    if (resumeTaskId && resumeTaskId === context.taskId) {
      const [t] = await db
        .select({ id: tasks.id, status: tasks.status, teamId: tasks.teamId, parentTaskId: tasks.parentTaskId, repositoryId: tasks.repositoryId })
        .from(tasks)
        .where(and(eq(tasks.id, resumeTaskId), eq(tasks.workspaceId, workspaceId)));
      if (t && t.teamId === team.id && !t.parentTaskId && !TERMINAL_STATUSES.includes(t.status)) {
        // Edit & Approve may have picked another repository (or none): the resumed task builds there
        if ("repositoryId" in p) {
          const repositoryId = typeof p.repositoryId === "string" && p.repositoryId ? p.repositoryId : null;
          if (repositoryId !== t.repositoryId) {
            if (repositoryId) {
              const [repo] = UUID_RE.test(repositoryId)
                ? await db.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)))
                : [];
              if (!repo) return { ok: false, summary: "The chosen repository does not exist in this workspace." };
            }
            await db.update(tasks).set({ repositoryId }).where(eq(tasks.id, t.id));
          }
        }
        return { ok: true, summary: `Approved: ${team.name} continues this task with the PRD`, details: { resumedTaskId: t.id } };
      }
    }
  }
  let dev: { id: string; name: string } | undefined;
  if (!team) {
    if (!developerId) return { ok: false, summary: "Choose a division (Edit & Approve) before approving the handoff." };
    [dev] = UUID_RE.test(developerId) ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, developerId), eq(employees.workspaceId, workspaceId))) : [];
    if (!dev) return { ok: false, summary: "The chosen developer no longer exists in this workspace: choose a division (Edit & Approve)." };
  }
  const repositoryId = typeof p.repositoryId === "string" ? p.repositoryId : null;
  let t: TaskRow;
  try {
    t = await createTask(db, {
      workspaceId,
      title: `Implement: ${title}`,
      brief: `Implement the approved PRD below. Ask before deviating from its scope or acceptance criteria.

---
${String(p.prd ?? "")}`,
      ...(team ? { teamId: team.id } : { assigneeId: dev!.id }),
      originTaskId: context.taskId ?? null,
      repositoryId,
      clientId: typeof p.clientId === "string" ? p.clientId : null,
      projectId: typeof p.projectId === "string" ? p.projectId : null,
      source: "board",
      // the PRD was written by a run that handled untrusted content (the origin link covers an untrusted task)
      untrustedInput: context.untrusted === true,
    });
  } catch (e) {
    if (!(e instanceof TaskInputError)) throw e;
    if (e.code === "repository_not_found") return { ok: false, summary: "The chosen repository does not exist in this workspace." };
    return { ok: false, summary: `The ${team ? "division" : "Developer"} task could not be created: ${e.message}.` };
  }
  const executor = team?.leadId ?? dev!.id;
  await publish(workspaceId, { type: "task.created", taskId: t.id, title: t.title, employeeId: executor });
  await enqueueTask(t.id, workspaceId);
  return { ok: true, summary: team ? `Created task "${t.title}" for ${team.name}` : `Created Developer task "${t.title}" for ${dev!.name}`, details: { taskId: t.id } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Routines proposed by an employee (propose_routine → approval "create_routine" → created here)
// ---------------------------------------------------------------------------

/** What propose_routine takes, and what an approved create_routine payload must still satisfy. */
export const routineProposalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // the shared rule (exactly 5 fields: minute hour day month weekday), the same one the web's routine form applies
  cron: z.string().trim().pipe(routineInputSchema.shape.cron),
  timezone: z.string().trim().min(1).max(64),
  brief: z.string().trim().min(1).max(20000),
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  overlap: z.enum(ROUTINE_OVERLAP_MODES).optional(),
});

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next `n` firings of a cron expression in a time zone; throws with a readable message when it is invalid. */
export function cronNextRuns(cron: string, timezone: string, n = 3, from = new Date()): Date[] {
  if (!isTimeZone(timezone)) throw new Error(`Unknown time zone "${timezone}" (use an IANA name such as Asia/Jakarta)`);
  let it;
  try {
    it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  } catch (e) {
    throw new Error(`Invalid cron expression "${cron}": ${(e as Error).message}`);
  }
  return Array.from({ length: n }, () => it.next().toDate());
}

/** "2026-10-12 09:00 (Asia/Jakarta)": a firing time as people read it in the routine's zone. */
export function formatRunTime(d: Date, timezone: string): string {
  const s = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${s} (${timezone})`;
}

/**
 * Why a routine's target is refused (null = fine): exactly one of assignee / team, and it must belong to the
 * workspace (the same rule createTask applies to the tasks the routine will create).
 */
export async function routineTargetError(workspaceId: string, assigneeId: string | null | undefined, teamId: string | null | undefined): Promise<string | null> {
  if (assigneeId && teamId) return "Give either an assignee or a team, not both.";
  if (!assigneeId && !teamId) return "Assign the routine to an employee or a team.";
  if (assigneeId) {
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, assigneeId), eq(employees.workspaceId, workspaceId))).limit(1);
    if (!e) return "Unknown employee: the assignee is not an employee of this workspace.";
  }
  if (teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId))).limit(1);
    if (!t) return "Unknown team: the team is not part of this workspace.";
  }
  return null;
}

/** The person who approved the create_routine / create_skill approval (decided_by), for the audit entry. */
async function approver(workspaceId: string, context: { approvalId?: string | null; employeeId?: string | null }, toolName = "create_routine"): Promise<{ id: string; email: string } | null> {
  const where = context.approvalId
    ? and(eq(approvals.id, context.approvalId), eq(approvals.workspaceId, workspaceId))
    : // executeApproval has claimed the row (EXECUTING) before it calls executeAction
      and(eq(approvals.workspaceId, workspaceId), eq(approvals.toolName, toolName), eq(approvals.status, "EXECUTING"), context.employeeId ? eq(approvals.employeeId, context.employeeId) : undefined);
  const [a] = await db.select({ decidedBy: approvals.decidedBy }).from(approvals).where(where).orderBy(desc(approvals.decidedAt)).limit(1);
  if (!a?.decidedBy) return null;
  const [u] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, a.decidedBy));
  return u ?? null;
}

/**
 * Approved create_routine: re-validate the (possibly edited) payload, then create the routine enabled. A routine
 * proposed by a tainted run (`context.untrusted`, read from the run's own payload) is marked untrustedInput: a
 * person approved it, but its brief came from untrusted content, so every task it creates starts tainted.
 */
async function doCreateRoutine(
  workspaceId: string,
  payload: Record<string, unknown>,
  context: { approvalId?: string | null; employeeId?: string | null; untrusted?: boolean },
): Promise<ActionResult> {
  const parsed = routineProposalSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, summary: `Invalid routine: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}` };
  const p = parsed.data;
  let next: Date;
  try {
    next = cronNextRuns(p.cron, p.timezone, 1)[0]!;
  } catch (e) {
    return { ok: false, summary: (e as Error).message };
  }
  const refused = await routineTargetError(workspaceId, p.assigneeId, p.teamId);
  if (refused) return { ok: false, summary: refused };
  const [r] = await db
    .insert(routines)
    .values({
      workspaceId,
      name: p.name,
      cron: p.cron,
      timezone: p.timezone,
      brief: p.brief,
      assigneeId: p.assigneeId ?? null,
      teamId: p.teamId ?? null,
      overlap: p.overlap ?? "skip",
      enabled: true,
      untrustedInput: context.untrusted === true,
      nextRunAt: next,
    })
    .returning();
  const who = await approver(workspaceId, context);
  await audit({
    workspaceId,
    actorUserId: who?.id ?? null,
    actorLabel: who?.email ?? "approval",
    action: "routine.created",
    targetType: "routine",
    targetId: r!.id,
    details: { cron: r!.cron, name: r!.name, timezone: r!.timezone, proposedBy: context.employeeId ?? null, approvalId: context.approvalId ?? null, untrustedInput: r!.untrustedInput },
  });
  const locale = await workspaceLocale(workspaceId);
  return { ok: true, summary: msg(locale, "routine.created", { name: r!.name, next: formatRunTime(next, r!.timezone) }), details: { routineId: r!.id, nextRunAt: next.toISOString() } };
}

// ---------------------------------------------------------------------------
// Skills proposed by an employee (skill_propose → approval "create_skill" → saved here)
// ---------------------------------------------------------------------------

/** How many numbered slugs (<slug>-2, -3, ...) are tried when the proposed one is taken. */
const SKILL_SLUG_ATTEMPTS = 50;

/** `<base>-<n>` within the slug length cap (the base is shortened, never the suffix). */
function numberedSlug(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, SKILL_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/**
 * Approved create_skill: re-validate the (possibly edited) payload, save it as a learned skill under a slug that is
 * free in the workspace and not a built-in skill's name (<slug>-2, ... when taken or reserved) and assign it to the proposing employee (the approval's employee,
 * never a payload field). `context.untrusted` is read from the run's ORIGINAL payload: a skill learned by a tainted
 * run stays untrusted however the person edited it, so reading it later taints the reader's run.
 */
async function doCreateSkill(
  workspaceId: string,
  payload: Record<string, unknown>,
  context: { approvalId?: string | null; employeeId?: string | null; untrusted?: boolean },
): Promise<ActionResult> {
  const parsed = skillProposalSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, summary: `Invalid skill: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}` };
  const p = parsed.data;
  if (screenLeakage(`${p.description}\n${p.body}`).some((f) => f.severity === "high")) {
    return { ok: false, summary: "The skill looks like it contains a secret or credential: remove it (Edit & Approve) before saving." };
  }
  if (!context.employeeId) return { ok: false, summary: "The skill has no proposing employee to assign it to." };
  const [emp] = await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(employees.id, context.employeeId), eq(employees.workspaceId, workspaceId)));
  if (!emp) return { ok: false, summary: "The proposing employee no longer exists in this workspace." };
  const who = await approver(workspaceId, context, "create_skill");
  const untrusted = context.untrusted === true;

  let saved: typeof skills.$inferSelect | undefined;
  for (let n = 1; n <= SKILL_SLUG_ATTEMPTS && !saved; n++) {
    const slug = numberedSlug(p.slug, n);
    if (isReservedSkillSlug(slug)) continue; // a built-in's name (pdf, docx, ...): saved as <slug>-2
    // insert-or-skip on the (workspace, slug) unique index: a slug taken meanwhile moves on to the next number
    saved = await withEmployeeRevision(db, emp.id, { workspaceId, source: "skill_install", actorUserId: who?.id ?? null, actorLabel: who?.email ?? "approval", note: slug }, async (tx) => {
      const [row] = await tx
        .insert(skills)
        .values({
          workspaceId,
          slug,
          description: p.description,
          body: p.body,
          source: "learned",
          enabled: true,
          untrusted,
          provenanceHash: skillProvenanceHash({ slug, description: p.description, body: p.body }),
          createdBy: who?.id ?? null,
        })
        .onConflictDoNothing({ target: [skills.workspaceId, skills.slug] })
        .returning();
      if (!row) return undefined;
      await tx.insert(employeeSkills).values({ employeeId: emp.id, skillId: row.id }).onConflictDoNothing();
      return row;
    });
  }
  if (!saved) return { ok: false, summary: `No free name for skill "${p.slug}" (tried ${SKILL_SLUG_ATTEMPTS}): rename it (Edit & Approve).` };
  await audit({
    workspaceId,
    actorUserId: who?.id ?? null,
    actorLabel: who?.email ?? "approval",
    action: "skill.created",
    targetType: "skill",
    targetId: saved.id,
    details: { slug: saved.slug, proposedSlug: p.slug, source: "learned", proposedBy: emp.id, assignedTo: emp.id, approvalId: context.approvalId ?? null, untrusted, provenanceHash: saved.provenanceHash },
  });
  const locale = await workspaceLocale(workspaceId);
  return { ok: true, summary: msg(locale, "skill.created", { slug: saved.slug, employee: emp.name }), details: { skillId: saved.id, slug: saved.slug, untrusted } };
}

async function repoFor(workspaceId: string, repositoryId: unknown): Promise<(RepoRef & { name: string }) | null> {
  if (typeof repositoryId !== "string") return null;
  const [r] = await db.select().from(repositories).where(and(eq(repositories.id, repositoryId), eq(repositories.workspaceId, workspaceId)));
  if (!r) return null;
  return { id: r.id, name: r.name, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, token: r.tokenEnc ? decryptSecret(r.tokenEnc) : null };
}

/** Push exactly the approved commit (payload.head) from the platform mirror. */
async function doGitPush(workspaceId: string, p: Record<string, unknown>, context: { taskId?: string | null }): Promise<ActionResult> {
  const repo = await repoFor(workspaceId, p.repositoryId);
  if (!repo || !context.taskId) return { ok: false, summary: "Repository not found" };
  const r = await pushAgentBranch(repo, context.taskId, String(p.head ?? ""));
  return { ok: r.ok, summary: r.summary, details: { branch: p.branch, head: p.head } };
}

/**
 * A person's decision to merge a task's pushed commit (payload.head) into the default branch. Never an agent tool:
 * the web creates this approval already approved. The commit message names who merged it.
 */
async function doMergeBranch(workspaceId: string, p: Record<string, unknown>, context: { taskId?: string | null; approvalId?: string | null }): Promise<ActionResult> {
  const repo = await repoFor(workspaceId, p.repositoryId);
  if (!repo || !context.taskId) return { ok: false, summary: "Repository not found" };
  const [a] = context.approvalId ? await db.select({ decidedBy: approvals.decidedBy }).from(approvals).where(eq(approvals.id, context.approvalId)) : [];
  const [u] = a?.decidedBy ? await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, a.decidedBy)) : [];
  const title = String(p.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const message = `Merge ${agentBranch(context.taskId)}${title ? `: ${title}` : ""}\n\nMerged in Workforce OS${u ? ` by ${u.email}` : ""}.`;
  const r = await mergeAgentBranch(repo, { taskId: context.taskId, head: String(p.head ?? ""), message, author: { name: u?.name || "Workforce OS", email: u?.email ?? "noreply@workforce-os.local" } });
  return { ok: r.ok, summary: r.summary, details: { commit: r.commit ?? null, fastForward: r.fastForward ?? false, alreadyMerged: r.alreadyMerged ?? false, conflicts: r.conflicts ?? [] } };
}

async function doCreatePullRequest(workspaceId: string, p: Record<string, unknown>): Promise<ActionResult> {
  const repo = await repoFor(workspaceId, p.repositoryId);
  if (!repo) return { ok: false, summary: "Repository not found" };
  const r = await createPullRequest(repo, { taskId: String(p.taskId), title: String(p.title ?? ""), body: String(p.body ?? ""), base: String(p.base ?? repo.defaultBranch) }, providerFetch());
  return { ok: r.ok, summary: r.summary, details: { url: r.url } };
}

/** Provider HTTP client (swappable in tests: no real GitHub/GitLab calls). */
let providerFetchImpl: ProviderFetch | null = null;
export function setProviderFetch(f: ProviderFetch | null): void {
  providerFetchImpl = f;
}
function providerFetch(): ProviderFetch {
  return providerFetchImpl ?? (fetch as unknown as ProviderFetch);
}

/** fetch for the MCP transport that never lets the runtime follow a redirect (redirectPolicy "same-origin" decides). */
export const noAutoRedirectFetch: FetchLike = (url, init) => fetch(url, { ...init, redirect: "manual" });

export async function callExternalMcpTool(workspaceId: string, server: string, tool: string, args: Record<string, unknown>): Promise<ActionResult> {
  const servers = await getExternalMcpServers(workspaceId);
  const s = servers.find((x) => x.name === server);
  if (!s) return { ok: false, summary: `MCP server ${server} not connected` };
  const client = new Client({ name: "workforce-os", version: "0.1.0" });
  // the runtime never follows a redirect by itself; the SDK follows one only within the server's origin, so the
  // auth header is never sent to a host it was not configured for (same as apps/web/src/lib/server/mcp.ts)
  const transport = new StreamableHTTPClientTransport(new URL(s.url), {
    requestInit: { headers: s.headers },
    redirectPolicy: "same-origin",
    fetch: noAutoRedirectFetch,
  });
  try {
    await withRetry(() => client.connect(transport), { retries: 1, timeoutMs: 15000, label: "mcp-connect" });
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const text = Array.isArray(r.content)
      ? r.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
      : JSON.stringify(r);
    return { ok: !r.isError, summary: text.slice(0, 2000) };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Execute an irreversible action with its exact (possibly human-edited) payload.
 * Only called after the gate said "run" or a human approved.
 */
export async function executeAction(
  workspaceId: string,
  toolName: string,
  payload: Record<string, unknown>,
  /**
   * untrusted: the run that asked for this action was tainted (approval payload untrustedInput);
   * approvalId: the approval being executed (create_routine audits its approver);
   * trigger: what let send_email / send_invoice run, stored on the outbox row (default: approval when approvalId is set,
   * else allow_list)
   */
  context: { taskId?: string | null; employeeId?: string | null; untrusted?: boolean; approvalId?: string | null; trigger?: OutboundEmailTrigger } = {},
): Promise<ActionResult> {
  const send = {
    trigger: context.trigger ?? (context.approvalId ? "approval" : "allow_list"),
    taskId: context.taskId ?? null,
    employeeId: context.employeeId ?? null,
    approvalId: context.approvalId ?? null,
  } as const;
  switch (toolName) {
    case "bash":
      return doRunApprovedCommand(workspaceId, String(payload.command ?? ""), context);
    case "handoff_prd":
      return doHandoffPrd(workspaceId, payload, context);
    case "git_push":
      return doGitPush(workspaceId, payload, context);
    case "create_pull_request":
      return doCreatePullRequest(workspaceId, payload);
    case "merge_branch":
      return doMergeBranch(workspaceId, payload, context);
    case "request_preview":
      return queuePreviewRelease(workspaceId, payload, context);
    case "request_release":
      // only from an approval an Owner decided (checked inside), never an allow-list run
      return queueLiveRelease(workspaceId, payload, context);
    case "send_email":
      return sendEmailPayload(workspaceId, emailPayloadSchema.parse(payload), send);
    case "send_invoice":
      return sendInvoicePayload(workspaceId, invoicePayloadSchema.parse(payload), send);
    case "post_webhook":
      return doPostWebhook(workspaceId, webhookPayloadSchema.parse(payload));
    case "create_routine":
      return doCreateRoutine(workspaceId, payload, context);
    case "create_skill":
      return doCreateSkill(workspaceId, payload, context);
    case "install_skill":
      return doInstallSkill(workspaceId, payload, { approver: await approver(workspaceId, context, "install_skill") });
    default: {
      if (toolName.startsWith("mcp__")) {
        const [, server, ...rest] = toolName.split("__");
        return callExternalMcpTool(workspaceId, server!, rest.join("__"), payload);
      }
      return { ok: false, summary: `Unknown irreversible tool ${toolName}` };
    }
  }
}
