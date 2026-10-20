import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, employees, employeeSkills, members, skills, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { PATCH as patchEmployee } from "@/app/api/employees/[id]/route";
import { PUT as putSkills } from "@/app/api/employees/[id]/skills/route";
import { GET as listRevisions } from "@/app/api/employees/[id]/revisions/route";
import { POST as revisionAction } from "@/app/api/employees/[id]/revisions/[version]/route";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Bima", role: "Backend", model: "m", instructions: "Write tests first.", dailyBudget: 1000 }).returning();
  const [sk] = await db.insert(skills).values({ workspaceId: ws!.id, slug: "postgres-patterns", description: "pg", body: "b", source: "catalog", provenanceHash: "h" }).returning();
  return { ws: ws!, emp: emp!, sk: sk! };
}
async function signIn(wsId: string, role: "OWNER" | "ADMIN" | "MEMBER") {
  const email = `r-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: wsId, userId: u!.id, role });
  resetBrowser();
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return email;
}
type Rev = { version: number; source: string; changed: string[]; restoredVersion: number | null; actorLabel: string; config: { instructions: string; dailyBudget: number; skills: (string | null)[] } };
const revisions = async (id: string) => (await callWithParams(listRevisions, "GET", `/api/employees/${id}/revisions`, undefined, { id })).json.revisions as Rev[];

describe("employee configuration revisions (P2)", () => {
  it("an edit keeps the state before as version 1 and the change as version 2; skills add a version; a no-op adds none", async () => {
    const { ws, emp, sk } = await setup();
    const email = await signIn(ws.id, "ADMIN");
    expect((await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { instructions: "Write tests first. Explain the migration.", dailyBudget: 2000 }, { id: emp.id })).status).toBe(200);
    expect((await callWithParams(putSkills, "PUT", `/api/employees/${emp.id}/skills`, { skillIds: [sk.id] }, { id: emp.id })).status).toBe(200);
    expect((await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { dailyBudget: 2000 }, { id: emp.id })).status).toBe(200);

    const revs = await revisions(emp.id);
    expect(revs.map((r) => [r.version, r.source, r.changed])).toEqual([
      [3, "skills", ["skillIds"]],
      [2, "person", ["instructions", "dailyBudget"]],
      [1, "baseline", []],
    ]);
    expect(revs[0]).toMatchObject({ actorLabel: email, config: { skills: ["postgres-patterns"] } });
    expect(revs[2]!.config).toMatchObject({ instructions: "Write tests first.", dailyBudget: 1000, skills: [] });
  });

  it("an Admin restores a version: fields and skills come back as a new 'rollback' version, audited; a member cannot", async () => {
    const { ws, emp, sk } = await setup();
    await signIn(ws.id, "ADMIN");
    await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { instructions: "Bad prompt from a replay." }, { id: emp.id });
    await callWithParams(putSkills, "PUT", `/api/employees/${emp.id}/skills`, { skillIds: [sk.id] }, { id: emp.id });

    const r = await callWithParams(revisionAction, "POST", `/api/employees/${emp.id}/revisions/1`, { action: "restore" }, { id: emp.id, version: "1" });
    expect(r.status).toBe(200);
    const [after] = await db.select().from(employees).where(eq(employees.id, emp.id));
    expect(after).toMatchObject({ instructions: "Write tests first.", instructionsVersion: 3 });
    expect(await db.select().from(employeeSkills).where(eq(employeeSkills.employeeId, emp.id))).toEqual([]);
    const revs = await revisions(emp.id);
    expect(revs[0]).toMatchObject({ version: 4, source: "rollback", restoredVersion: 1, changed: ["instructions", "skillIds"] });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "employee.revision_restored"), eq(auditLog.targetId, emp.id)))).toHaveLength(1);
    expect((await callWithParams(revisionAction, "POST", `/api/employees/${emp.id}/revisions/99`, { action: "restore" }, { id: emp.id, version: "99" })).json.code).toBe("revision_not_found");

    await signIn(ws.id, "MEMBER");
    expect((await callWithParams(revisionAction, "POST", `/api/employees/${emp.id}/revisions/2`, { action: "restore" }, { id: emp.id, version: "2" })).status).toBe(403);
  });

  it("restoring a different allow-list is the Owner's", async () => {
    const { ws, emp } = await setup();
    await signIn(ws.id, "OWNER");
    await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { allowList: [{ tool: "send_email", match: { to: "a@b.co" } }] }, { id: emp.id });
    await signIn(ws.id, "ADMIN");
    const r = await callWithParams(revisionAction, "POST", `/api/employees/${emp.id}/revisions/1`, { action: "restore" }, { id: emp.id, version: "1" });
    expect(r.json.code).toBe("owner_only_allow_list");
  });
});
