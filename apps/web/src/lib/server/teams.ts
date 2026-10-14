import "server-only";
import { and, asc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { audit, db, employees, steps, tasks, teamMembers, teams } from "@wfos/db";
import { teamInputSchema, type TeamInput, type TeamMemberRole } from "@wfos/shared";
import type { MentionMember } from "@/lib/mentions";
import { HttpError, type Session } from "./auth";
import { notFound } from "./route";

/** A team's Lead and members must be employees of the session's workspace (400 otherwise). */
export async function assertWorkspaceEmployees(workspaceId: string, ids: (string | null | undefined)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return;
  const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.workspaceId, workspaceId), inArray(employees.id, wanted)));
  if (found.length !== wanted.length) throw new HttpError(400, "Unknown employee", { code: "unknown_employee" });
}

/** A routine's (or task's) team must belong to the session's workspace (400 otherwise). */
export async function assertWorkspaceTeam(workspaceId: string, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)));
  if (!t) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
}

/**
 * A team's active members (Lead first, then by name), the only people an @mention can address. Shared by the chat
 * messages route and the MCP server's send_message.
 */
export async function teamRoster(workspaceId: string, teamId: string): Promise<MentionMember[]> {
  const [t] = await db.select({ leadId: teams.leadId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  if (!t) return [];
  const rows = await db
    .selectDistinct({ id: employees.id, name: employees.name })
    .from(employees)
    .leftJoin(teamMembers, and(eq(teamMembers.employeeId, employees.id), eq(teamMembers.teamId, teamId)))
    .where(
      and(
        eq(employees.workspaceId, workspaceId),
        ne(employees.status, "ARCHIVED"),
        // the Lead counts even when a lead-only edit left them out of team_members
        t.leadId ? or(eq(teamMembers.teamId, teamId), eq(employees.id, t.leadId)) : eq(teamMembers.teamId, teamId),
      ),
    )
    .orderBy(asc(employees.name));
  return [...rows.filter((r) => r.id === t.leadId), ...rows.filter((r) => r.id !== t.leadId)];
}

// ---------------------------------------------------------------------------------------------------------------
// Divisions (UI "Divisi"): stored in `teams`. One division per employee; structure changes are Owner/Admin and audited.
// ---------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"] as const;

export interface DivisionMemberDTO {
  employeeId: string;
  role: TeamMemberRole;
  /** credits of the steps this person acted in over the last 7 days (work as a subagent counts for the subagent) */
  credits7d: number;
}

export interface DivisionDTO {
  id: string;
  key: string | null;
  name: string;
  description: string;
  color: string;
  sop: { en: string; id: string };
  leadId: string | null;
  codeLeadId: string | null;
  maxParallel: number;
  dailyBudget: number | null;
  sortOrder: number;
  responderMode: TeamInput["responderMode"];
  members: DivisionMemberDTO[];
  /** tasks of the division or assigned to one of its members: running (incl. awaiting approval) and queued */
  workload: { running: number; queued: number };
  credits7d: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Every division of the workspace in org-chart order, with members, current workload and 7-day credits. */
export async function listDivisions(workspaceId: string, now = new Date()): Promise<DivisionDTO[]> {
  const ds = await db.select().from(teams).where(eq(teams.workspaceId, workspaceId)).orderBy(asc(teams.sortOrder), asc(teams.name));
  if (!ds.length) return [];
  const ms = await db.select().from(teamMembers).where(inArray(teamMembers.teamId, ds.map((d) => d.id)));
  const memberIds = [...new Set(ms.map((m) => m.employeeId))];
  const [active, spend] = await Promise.all([
    db
      .select({ id: tasks.id, teamId: tasks.teamId, assigneeId: tasks.assigneeId, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, [...ACTIVE_STATUSES]))),
    memberIds.length
      ? db
          .select({ who: sql<string>`coalesce(${steps.actorEmployeeId}, ${steps.employeeId})`, credits: sql<number>`coalesce(sum(${steps.credits}), 0)::float` })
          .from(steps)
          .where(
            and(
              eq(steps.workspaceId, workspaceId),
              gte(steps.createdAt, new Date(now.getTime() - 7 * DAY_MS)),
              or(inArray(steps.employeeId, memberIds), inArray(steps.actorEmployeeId, memberIds)),
            ),
          )
          .groupBy(sql`1`)
      : Promise.resolve([] as { who: string; credits: number }[]),
  ]);
  const creditsOf = new Map(spend.map((s) => [s.who, Number(s.credits)]));
  return ds.map((d) => {
    const mine = ms.filter((m) => m.teamId === d.id);
    const ids = new Set(mine.map((m) => m.employeeId));
    const work = active.filter((t) => t.teamId === d.id || (!!t.assigneeId && ids.has(t.assigneeId)));
    const members = mine.map((m) => ({ employeeId: m.employeeId, role: m.role, credits7d: creditsOf.get(m.employeeId) ?? 0 }));
    return {
      id: d.id,
      key: d.key,
      name: d.name,
      description: d.description,
      color: d.color,
      sop: d.sop,
      leadId: d.leadId,
      codeLeadId: d.codeLeadId,
      maxParallel: d.maxParallel,
      dailyBudget: d.dailyBudget,
      sortOrder: d.sortOrder,
      responderMode: d.responderMode,
      members,
      workload: { running: work.filter((t) => t.status !== "QUEUED").length, queued: work.filter((t) => t.status === "QUEUED").length },
      credits7d: members.reduce((s, m) => s + m.credits7d, 0),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

type TeamRow = typeof teams.$inferSelect;
type Member = { employeeId: string; role: TeamMemberRole };

/** A stored division as teamInputSchema input; a head or code lead left out of team_members (older edits) is a member. */
function asInput(t: TeamRow, ms: Member[]): Record<string, unknown> {
  const members = ms.map((m) => ({ ...m }));
  for (const id of [t.leadId, t.codeLeadId]) {
    if (!id) continue;
    const m = members.find((x) => x.employeeId === id);
    if (!m) members.push({ employeeId: id, role: "member" });
    else m.role = "member";
  }
  return {
    name: t.name,
    key: t.key,
    description: t.description,
    leadId: t.leadId,
    codeLeadId: t.codeLeadId,
    members,
    responderMode: t.responderMode,
    sop: t.sop,
    color: t.color,
    maxParallel: t.maxParallel,
    dailyBudget: t.dailyBudget,
    sortOrder: t.sortOrder,
  };
}

/**
 * The structure rules of `divisionStructureError` (@wfos/shared), each as its own translated 400 so the Divisions
 * page can say exactly what is wrong. Runs on the raw body before the schema (which applies the same rules again).
 */
function assertStructure(raw: Record<string, unknown>): void {
  if (!Array.isArray(raw.members)) return;
  const members = (raw.members as { employeeId?: unknown; role?: unknown }[]).map((m) => ({ employeeId: String(m?.employeeId ?? ""), role: m?.role === "subagent" ? "subagent" : "member" }));
  const leadId = typeof raw.leadId === "string" ? raw.leadId : null;
  const codeLeadId = typeof raw.codeLeadId === "string" ? raw.codeLeadId : null;
  const ids = members.map((m) => m.employeeId);
  const roleOf = (id: string) => members.find((m) => m.employeeId === id)?.role;
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "An employee is listed twice in this division", { code: "division_duplicate_member" });
  if (leadId && roleOf(leadId) !== "member") throw new HttpError(400, "The head must be a member of the division (not a subagent)", { code: "division_head_not_member" });
  if (codeLeadId && roleOf(codeLeadId) !== "member") throw new HttpError(400, "The code lead must be a member of the division (not a subagent)", { code: "division_code_lead_not_member" });
  if (codeLeadId && codeLeadId === leadId) throw new HttpError(400, "The head and the code lead must be different people", { code: "division_head_is_code_lead" });
  if (!codeLeadId && members.some((m) => m.role === "subagent")) throw new HttpError(400, "Subagents need a code lead", { code: "division_subagents_need_code_lead" });
}

/** the unique index a Postgres unique violation hit, null for any other error */
function uniqueConstraint(e: unknown): string | null {
  const err = (e as { cause?: unknown })?.cause ?? e;
  const pg = err as { code?: string; constraint_name?: string };
  return pg?.code === "23505" ? (pg.constraint_name ?? "") : null;
}

export interface SaveDivisionOptions {
  /** the division to update; absent = create */
  id?: string;
  /** move employees who are in another division instead of refusing (409 employee_in_other_division) */
  move?: boolean;
}

/**
 * Create or update a division. `raw` is the request body: for an update it is merged over the stored division, then
 * the whole result is validated (teamInputSchema), so a partial PATCH can never leave a broken structure. Checks:
 * every person is an employee of this workspace (400), the key is free (409), nobody is in another division unless
 * `move` (409), and a code lead is not moved away from subagents who still need them (409). One audit entry with the
 * acting user records what changed; a division people were moved out of gets its own entry.
 */
export async function saveDivision(session: Session, raw: Record<string, unknown>, opts: SaveDivisionOptions = {}): Promise<TeamRow> {
  const ws = session.workspaceId;
  let before: TeamRow | null = null;
  let beforeMembers: Member[] = [];
  if (opts.id) {
    if (!UUID.test(opts.id)) notFound("team_not_found");
    const [t] = await db.select().from(teams).where(and(eq(teams.id, opts.id), eq(teams.workspaceId, ws)));
    if (!t) notFound("team_not_found");
    before = t;
    beforeMembers = (await db.select().from(teamMembers).where(eq(teamMembers.teamId, t.id))).map((m) => ({ employeeId: m.employeeId, role: m.role }));
  }
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "move"));
  const merged = before ? { ...asInput(before, beforeMembers), ...body } : body;
  assertStructure(merged);
  const input = teamInputSchema.parse(merged);
  const ids = [...new Set([input.leadId, input.codeLeadId, ...input.members.map((m) => m.employeeId)].filter((x): x is string => !!x))];
  await assertWorkspaceEmployees(ws, ids);

  if (input.key) {
    const [taken] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.workspaceId, ws), eq(teams.key, input.key), opts.id ? ne(teams.id, opts.id) : undefined));
    if (taken) throw new HttpError(409, "Another division already uses this key", { code: "division_key_taken", key: input.key });
  }

  // people who are in another division now
  const elsewhere = ids.length
    ? await db
        .select({ employeeId: teamMembers.employeeId, role: teamMembers.role, teamId: teams.id, teamName: teams.name, leadId: teams.leadId, codeLeadId: teams.codeLeadId, employeeName: employees.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .innerJoin(employees, eq(employees.id, teamMembers.employeeId))
        .where(and(eq(teams.workspaceId, ws), inArray(teamMembers.employeeId, ids), opts.id ? ne(teams.id, opts.id) : undefined))
    : [];
  if (elsewhere.length && !opts.move) {
    const e = elsewhere[0]!;
    throw new HttpError(409, `${e.employeeName} is already in division ${e.teamName}`, { code: "employee_in_other_division", employee: e.employeeName, division: e.teamName, employeeId: e.employeeId, teamId: e.teamId });
  }
  for (const e of elsewhere) {
    if (e.codeLeadId !== e.employeeId) continue;
    const [sub] = await db
      .select({ employeeId: teamMembers.employeeId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.role, "subagent"), ne(teamMembers.employeeId, e.employeeId)))
      .limit(1);
    if (sub) throw new HttpError(409, `${e.employeeName} is the code lead of ${e.teamName}, whose subagents still need them`, { code: "code_lead_has_subagents", employee: e.employeeName, division: e.teamName });
  }

  const values = {
    name: input.name,
    key: input.key ?? null,
    description: input.description,
    leadId: input.leadId,
    codeLeadId: input.codeLeadId,
    responderMode: input.responderMode,
    sop: input.sop,
    color: input.color,
    maxParallel: input.maxParallel,
    dailyBudget: input.dailyBudget,
    sortOrder: input.sortOrder,
  };
  let row: TeamRow;
  try {
    row = await db.transaction(async (tx) => {
      // moved people leave their old division first (and stop being its head or code lead)
      for (const e of elsewhere) {
        await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.employeeId, e.employeeId)));
        if (e.leadId === e.employeeId) await tx.update(teams).set({ leadId: null }).where(eq(teams.id, e.teamId));
        if (e.codeLeadId === e.employeeId) await tx.update(teams).set({ codeLeadId: null }).where(eq(teams.id, e.teamId));
      }
      const [t] = opts.id
        ? await tx.update(teams).set(values).where(and(eq(teams.id, opts.id), eq(teams.workspaceId, ws))).returning()
        : await tx.insert(teams).values({ ...values, workspaceId: ws }).returning();
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, t!.id));
      if (input.members.length) await tx.insert(teamMembers).values(input.members.map((m) => ({ teamId: t!.id, employeeId: m.employeeId, role: m.role })));
      return t!;
    });
  } catch (e) {
    const c = uniqueConstraint(e);
    if (c === "teams_ws_key") throw new HttpError(409, "Another division already uses this key", { code: "division_key_taken", key: input.key ?? "" });
    // someone put the same person in another division at the same moment
    if (c === "team_members_employee") throw new HttpError(409, "An employee is already in another division", { code: "employee_in_other_division_race" });
    throw e;
  }

  const actor = { workspaceId: ws, actorUserId: session.userId, actorLabel: session.email };
  const movedFrom = new Map<string, typeof elsewhere>();
  for (const e of elsewhere) movedFrom.set(e.teamId, [...(movedFrom.get(e.teamId) ?? []), e]);
  for (const [teamId, moved] of movedFrom) {
    await audit({
      ...actor,
      action: "division.members_moved_out",
      targetType: "team",
      targetId: teamId,
      details: {
        name: moved[0]!.teamName,
        to: { id: row.id, name: row.name },
        employees: moved.map((m) => ({ id: m.employeeId, name: m.employeeName, role: m.role, wasHead: m.leadId === m.employeeId, wasCodeLead: m.codeLeadId === m.employeeId })),
      },
    });
  }
  const roleBefore = new Map(beforeMembers.map((m) => [m.employeeId, m.role]));
  const roleAfter = new Map(input.members.map((m) => [m.employeeId, m.role]));
  await audit({
    ...actor,
    action: opts.id ? "division.updated" : "division.created",
    targetType: "team",
    targetId: row.id,
    details: {
      name: row.name,
      key: row.key,
      added: input.members.filter((m) => !roleBefore.has(m.employeeId)),
      removed: beforeMembers.filter((m) => !roleAfter.has(m.employeeId)).map((m) => m.employeeId),
      roleChanged: input.members.filter((m) => roleBefore.has(m.employeeId) && roleBefore.get(m.employeeId) !== m.role),
      ...((before?.leadId ?? null) !== input.leadId ? { head: { from: before?.leadId ?? null, to: input.leadId } } : {}),
      ...((before?.codeLeadId ?? null) !== input.codeLeadId ? { codeLead: { from: before?.codeLeadId ?? null, to: input.codeLeadId } } : {}),
      moved: elsewhere.map((e) => ({ employeeId: e.employeeId, from: e.teamId })),
      fields: Object.keys(body),
    },
  });
  return row;
}

/** Delete a division: its members become unassigned (their tasks and history stay). */
export async function deleteDivision(session: Session, id: string): Promise<void> {
  const ws = session.workspaceId;
  if (!UUID.test(id)) notFound("team_not_found");
  const [t] = await db.select().from(teams).where(and(eq(teams.id, id), eq(teams.workspaceId, ws)));
  if (!t) notFound("team_not_found");
  const ms = await db.select({ employeeId: teamMembers.employeeId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.teamId, t.id));
  await db.delete(teams).where(and(eq(teams.id, t.id), eq(teams.workspaceId, ws)));
  await audit({
    workspaceId: ws,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "division.deleted",
    targetType: "team",
    targetId: t.id,
    details: { name: t.name, key: t.key, leadId: t.leadId, codeLeadId: t.codeLeadId, members: ms },
  });
}

/**
 * Add one employee to a division (the hire page): the same rules as saving the division, so a subagent needs a code
 * lead and someone in another division is refused unless `move`.
 */
export async function addToDivision(session: Session, teamId: string, employeeId: string, role: TeamMemberRole, move = false): Promise<void> {
  const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, session.workspaceId)));
  if (!t) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
  const ms = (await db.select().from(teamMembers).where(eq(teamMembers.teamId, t.id))).map((m) => ({ employeeId: m.employeeId, role: m.role }));
  await saveDivision(session, { members: [...ms.filter((m) => m.employeeId !== employeeId), { employeeId, role }] }, { id: t.id, move });
}

/** Before hiring into a division: it belongs to this workspace (400 unknown_team) and a subagent has a code lead to work for. */
export async function assertCanJoinDivision(workspaceId: string, teamId: string, role: TeamMemberRole): Promise<void> {
  if (!UUID.test(teamId)) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
  const [t] = await db.select({ id: teams.id, codeLeadId: teams.codeLeadId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
  if (!t) throw new HttpError(400, "Unknown team", { code: "unknown_team" });
  if (role === "subagent" && !t.codeLeadId) throw new HttpError(400, "Subagents need a code lead", { code: "division_subagents_need_code_lead" });
}
