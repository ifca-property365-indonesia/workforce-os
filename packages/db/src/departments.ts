import { eq } from "drizzle-orm";
import { DEFAULT_DEPARTMENTS } from "@wfos/templates";
import { getDb } from "./index";
import { departments } from "./schema";

/** The workspace's departments; the defaults are copied in on first use (then they are the workspace's to edit). */
export async function workspaceDepartments(workspaceId: string) {
  const db = getDb();
  let rows = await db.select().from(departments).where(eq(departments.workspaceId, workspaceId));
  const missing = DEFAULT_DEPARTMENTS.filter((d) => !rows.some((r) => r.key === d.key));
  if (missing.length) {
    await db
      .insert(departments)
      .values(missing.map((d) => ({ workspaceId, key: d.key, name: d.name, sop: d.sop, subagents: d.subagents })))
      .onConflictDoNothing();
    rows = await db.select().from(departments).where(eq(departments.workspaceId, workspaceId));
  }
  return rows;
}
