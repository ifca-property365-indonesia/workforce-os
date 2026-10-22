import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, employees, members, users, workflowRuns, workflows, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as list, POST as create } from "@/app/api/workflows/route";
import { DELETE as remove, GET as getOne, PATCH as patch } from "@/app/api/workflows/[id]/route";
import { POST as runNow } from "@/app/api/workflows/[id]/run/route";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

beforeEach(() => {
  resetBrowser();
  vi.mocked(queueModule.q.misc).mockClear();
});

async function signedIn(role: "OWNER" | "ADMIN" | "MEMBER" = "ADMIN") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `wf-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "A", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Rina", role: "Sales", model: "m" }).returning();
  return { ws: ws!, emp: emp! };
}

const body = (employeeId: string, over: Record<string, unknown> = {}) => ({
  name: "Laporan mingguan",
  trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Asia/Jakarta" },
  steps: [
    { kind: "agent", employeeId, instruction: "Kumpulkan angka." },
    { kind: "approval", title: "Kirim?" },
  ],
  ...over,
});

describe("workflows API", () => {
  it("an admin creates a workflow that starts off; turning it on sets the next run, off clears it", async () => {
    const { ws, emp } = await signedIn();
    const r = await call(create, "POST", "/api/workflows", body(emp.id));
    expect(r.status).toBe(200);
    const id = (r.json.workflow as { id: string }).id;
    expect((await db.select().from(workflows).where(eq(workflows.id, id)))[0]).toMatchObject({ workspaceId: ws.id, enabled: false, nextRunAt: null });

    expect((await callWithParams(patch, "PATCH", `/api/workflows/${id}`, { enabled: true }, { id })).status).toBe(200);
    const [on] = await db.select().from(workflows).where(eq(workflows.id, id));
    expect(on!.enabled).toBe(true);
    expect(on!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "workflow.enabled")))).toHaveLength(1);

    expect((await callWithParams(patch, "PATCH", `/api/workflows/${id}`, { enabled: false, name: "Laporan" }, { id })).status).toBe(200);
    expect((await db.select().from(workflows).where(eq(workflows.id, id)))[0]).toMatchObject({ enabled: false, nextRunAt: null, name: "Laporan" });
  });

  it("refuses another workspace's employee, a bad cron, a workflow without an employee step, and a member", async () => {
    const { emp } = await signedIn();
    const other = await signedIn(); // signs in as the other workspace's admin
    let r = await call(create, "POST", "/api/workflows", body(emp.id));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("workflow_unknown_employee");
    r = await call(create, "POST", "/api/workflows", body(other.emp.id, { trigger: { kind: "schedule", cron: "61 * * * *", timezone: "Asia/Jakarta" } }));
    expect(r.json.code).toBe("invalid_cron");
    r = await call(create, "POST", "/api/workflows", body(other.emp.id, { steps: [{ kind: "notify", title: "x" }] }));
    expect(r.json.code).toBe("invalid_workflow");

    const member = await signedIn("MEMBER");
    expect((await call(create, "POST", "/api/workflows", body(member.emp.id))).status).toBe(403);
  });

  it("Run now queues a start, refuses while a run is open; the list shows who proposed it and the last run", async () => {
    const { ws, emp } = await signedIn();
    const [wf] = await db.insert(workflows).values({ workspaceId: ws.id, name: "Draf Rina", trigger: { kind: "manual" }, steps: body(emp.id).steps as never, proposedByEmployeeId: emp.id }).returning();
    expect((await callWithParams(runNow, "POST", `/api/workflows/${wf!.id}/run`, undefined, { id: wf!.id })).status).toBe(200);
    expect(queueModule.q.misc).toHaveBeenCalledWith(expect.objectContaining({ kind: "workflow_start", workflowId: wf!.id, workspaceId: ws.id }));

    await db.insert(workflowRuns).values({ workflowId: wf!.id, workspaceId: ws.id, steps: wf!.steps, status: "waiting" });
    const busy = await callWithParams(runNow, "POST", `/api/workflows/${wf!.id}/run`, undefined, { id: wf!.id });
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe("workflow_run_open");

    const rows = (await call(list, "GET", "/api/workflows")).json.workflows as { id: string; proposedBy: string | null; lastRun: { status: string } | null }[];
    expect(rows.find((w) => w.id === wf!.id)).toMatchObject({ proposedBy: "Rina", lastRun: { status: "waiting" } });
    const one = await callWithParams(getOne, "GET", `/api/workflows/${wf!.id}`, undefined, { id: wf!.id });
    expect((one.json.runs as unknown[]).length).toBe(1);

    expect((await callWithParams(remove, "DELETE", `/api/workflows/${wf!.id}`, undefined, { id: wf!.id })).status).toBe(200);
    expect(await db.select().from(workflows).where(eq(workflows.id, wf!.id))).toHaveLength(0);
  });
});
