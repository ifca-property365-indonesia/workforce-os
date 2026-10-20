import { asc, desc, eq, sql } from "drizzle-orm";
import { type DB } from "./index";
import { employeeRevisions, employees, employeeSkills, type EmployeeConfig, type EmployeeRevisionSource } from "./schema";

/**
 * P2 (after Paperclip): employee configuration revisions. Every path that changes how an employee works (a person's
 * edit, an HR replay applied, skills assigned or installed, a restore) runs inside withEmployeeRevision: the state
 * before the first recorded change becomes version 1 ("baseline"), and each change that really changed something adds
 * the next version with a full snapshot. A revision can be restored (a new revision, source "rollback").
 */

type Database = Pick<DB, "select" | "insert" | "update" | "delete" | "execute" | "transaction">;

/** The fields of an employee a revision keeps (the order a diff lists them in). */
export const EMPLOYEE_CONFIG_FIELDS = [
  "role",
  "specialty",
  "persona",
  "instructions",
  "businessContext",
  "model",
  "autonomyLevel",
  "toolPermissions",
  "allowList",
  "dailyBudget",
  "outputLanguage",
  "executionMode",
  "egressDomains",
  "skillIds",
] as const satisfies readonly (keyof EmployeeConfig)[];

/** The employee's configuration now (null: no such employee). Skill ids sorted, so equal sets compare equal. */
export async function snapshotEmployee(database: Pick<DB, "select">, employeeId: string): Promise<EmployeeConfig | null> {
  const [e] = await database.select().from(employees).where(eq(employees.id, employeeId));
  if (!e) return null;
  const sk = await database.select({ id: employeeSkills.skillId }).from(employeeSkills).where(eq(employeeSkills.employeeId, employeeId)).orderBy(asc(employeeSkills.skillId));
  return {
    role: e.role,
    specialty: e.specialty,
    persona: e.persona,
    instructions: e.instructions,
    businessContext: e.businessContext,
    model: e.model,
    autonomyLevel: e.autonomyLevel,
    toolPermissions: e.toolPermissions,
    allowList: e.allowList,
    dailyBudget: e.dailyBudget,
    outputLanguage: e.outputLanguage,
    executionMode: e.executionMode,
    egressDomains: e.egressDomains,
    skillIds: sk.map((s) => s.id),
  };
}

/** The fields that differ between two snapshots. */
export function changedFields(a: EmployeeConfig, b: EmployeeConfig): (keyof EmployeeConfig)[] {
  return EMPLOYEE_CONFIG_FIELDS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}

export interface RevisionMeta {
  workspaceId: string;
  source: Exclude<EmployeeRevisionSource, "baseline">;
  actorUserId?: string | null;
  actorLabel: string;
  note?: string;
  restoredVersion?: number;
}

/** serializes revision numbers per employee */
async function lockEmployee(database: Pick<DB, "execute">, employeeId: string): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`wfos-employee-rev:${employeeId}`}))`);
}

async function latest(database: Pick<DB, "select">, employeeId: string) {
  const [r] = await database.select().from(employeeRevisions).where(eq(employeeRevisions.employeeId, employeeId)).orderBy(desc(employeeRevisions.version)).limit(1);
  return r ?? null;
}

/**
 * Run `fn` (the change) in a transaction and record the employees' new revisions. Before it: an employee without any
 * revision gets its current state as version 1 (baseline); a state that drifted from the last revision (a path that
 * does not record) is kept as a baseline too, so a restore never loses it. After it: a revision for each employee
 * whose configuration changed.
 */
export async function withEmployeeRevision<T>(database: Database, employeeIds: string | string[], meta: RevisionMeta, fn: (tx: Database) => Promise<T>): Promise<T> {
  const ids = [...new Set(Array.isArray(employeeIds) ? employeeIds : [employeeIds])].sort();
  return database.transaction(async (tx) => {
    for (const id of ids) await lockEmployee(tx, id);
    for (const id of ids) {
      const now = await snapshotEmployee(tx, id);
      if (!now) continue;
      const last = await latest(tx, id);
      if (!last || changedFields(last.config, now).length)
        await tx.insert(employeeRevisions).values({ workspaceId: meta.workspaceId, employeeId: id, version: (last?.version ?? 0) + 1, config: now, source: "baseline" });
    }
    const out = await fn(tx);
    for (const id of ids) {
      const now = await snapshotEmployee(tx, id);
      const last = await latest(tx, id);
      if (!now || !last || !changedFields(last.config, now).length) continue;
      await tx.insert(employeeRevisions).values({
        workspaceId: meta.workspaceId,
        employeeId: id,
        version: last.version + 1,
        config: now,
        source: meta.source,
        actorUserId: meta.actorUserId ?? null,
        actorLabel: meta.actorLabel.slice(0, 200),
        note: (meta.note ?? "").slice(0, 500),
        restoredVersion: meta.restoredVersion ?? null,
      });
    }
    return out;
  });
}

/** An employee's revisions, newest first. */
export async function employeeRevisionList(database: Pick<DB, "select">, employeeId: string, limit = 50) {
  return database.select().from(employeeRevisions).where(eq(employeeRevisions.employeeId, employeeId)).orderBy(desc(employeeRevisions.version)).limit(limit);
}
