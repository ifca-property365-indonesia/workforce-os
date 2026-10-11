import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { conversations, db, employees, members, steps, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as activity } from "@/app/api/employees/[id]/activity/route";
import { describeReceipt } from "@/lib/step-labels";
import { callWithParams, call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const [task] = await db.insert(tasks).values({ workspaceId: ws!.id, title: "Monthly report", assigneeId: emp!.id }).returning();
  const [conv] = await db.insert(conversations).values({ workspaceId: ws!.id, title: "Invoices" }).returning();
  const email = `a-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "V", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "VIEWER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { ws: ws!, emp: emp!, task: task!, conv: conv! };
}

type Row = { id: string; name: string; kind: string; taskTitle: string | null; conversationId: string | null; conversationTitle: string | null };
const get = (empId: string, q = "") => callWithParams(activity, "GET", `/api/employees/${empId}/activity${q}`, undefined, { id: empId });

describe("GET /api/employees/[id]/activity", () => {
  it("pages newest first with ?before=<cursor> and ?limit, without gaps or repeats (equal timestamps too)", async () => {
    const { ws, emp, task } = await setup();
    const base = Date.now() - 3600_000;
    const same = new Date(base + 5 * 1000);
    const rows = await db
      .insert(steps)
      .values(
        Array.from({ length: 12 }, (_, i) => ({
          workspaceId: ws.id,
          employeeId: emp.id,
          taskId: task.id,
          kind: "tool" as const,
          name: `t${i}`,
          // three steps share one timestamp: the id breaks the tie
          createdAt: i >= 5 && i <= 7 ? same : new Date(base + i * 1000),
        })),
      )
      .returning();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await get(emp.id, `?limit=5${cursor ? `&before=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      const page = r.json.recent as Row[];
      seen.push(...page.map((s) => s.id));
      cursor = r.json.nextCursor as string | null;
      if (pages === 0) expect(r.json.daily).toBeDefined();
      else expect(r.json.daily).toBeUndefined();
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
    const first = (await get(emp.id, "?limit=2")).json.recent as Row[];
    expect(first.map((s) => s.name)).toEqual(["t11", "t10"]);
  });

  it("joins task and conversation titles and filters ?kinds", async () => {
    const { ws, emp, task, conv } = await setup();
    await db.insert(steps).values([
      { workspaceId: ws.id, employeeId: emp.id, taskId: task.id, kind: "tool", name: "send_email", input: { to: ["a@b.co"] } },
      { workspaceId: ws.id, employeeId: emp.id, conversationId: conv.id, kind: "approval", name: "approval_requested:send_invoice" },
      { workspaceId: ws.id, employeeId: emp.id, taskId: task.id, kind: "llm", name: "claude" },
      { workspaceId: ws.id, employeeId: emp.id, conversationId: randomUUID(), kind: "tool", name: "kb_search" },
    ]);
    const r = await get(emp.id, "?kinds=tool,approval,bogus");
    const rows = r.json.recent as Row[];
    expect(rows.map((s) => s.kind).sort()).toEqual(["approval", "tool", "tool"]);
    expect(rows.find((s) => s.name === "send_email")!.taskTitle).toBe("Monthly report");
    expect(rows.find((s) => s.name.startsWith("approval"))).toMatchObject({ conversationId: conv.id, conversationTitle: "Invoices" });
    // a conversation id that does not resolve in this workspace is not linked
    expect(rows.find((s) => s.name === "kb_search")).toMatchObject({ conversationId: null, conversationTitle: null });
  });

  it("clamps ?limit, ignores a junk cursor and stays inside the workspace", async () => {
    const { ws, emp } = await setup();
    await db.insert(steps).values(Array.from({ length: 120 }, (_, i) => ({ workspaceId: ws.id, employeeId: emp.id, kind: "tool" as const, name: `s${i}` })));
    expect(((await get(emp.id, "?limit=500")).json.recent as Row[]).length).toBe(100);
    expect(((await get(emp.id, "?limit=0")).json.recent as Row[]).length).toBe(1);
    expect(((await get(emp.id, "?limit=abc")).json.recent as Row[]).length).toBe(50);
    expect(((await get(emp.id, "?before=not-a-uuid")).json.recent as Row[]).length).toBe(50);
    const other = await setup();
    expect((await get(emp.id)).status).toBe(404);
    expect((await get(other.emp.id)).status).toBe(200);
  });
});

describe("describeReceipt", () => {
  const r = (kind: string, name: string, input: unknown = null) => describeReceipt({ kind, name, input, output: null });
  it("words what happened in plain language", () => {
    expect(r("tool", "send_email", { to: ["a@x.co", "b@x.co"], subject: "Hi" })).toEqual({ key: "send_email", values: { to: "a@x.co, b@x.co" }, tool: "send_email" });
    expect(r("tool", "simulated:send_email", { to: ["a@x.co"] })).toMatchObject({ key: "send_email", values: { to: "a@x.co" } });
    expect(r("tool", "kb_search", {})).toMatchObject({ key: "kb_search" });
    expect(r("tool", "kb_search", { query: "refund policy" })).toMatchObject({ key: "kb_search_query", values: { query: "refund policy" } });
    expect(r("approval", "approval_requested:send_invoice")).toEqual({ key: "approval", values: { tool: "send_invoice" }, tool: "send_invoice" });
    expect(r("tool", "mcp__drive__upload")).toEqual({ key: "tool", values: { tool: "mcp__drive__upload" }, tool: "mcp__drive__upload" });
    expect(r("tool", "gate:drive/upload", { rule: "autonomy" })).toEqual({ key: "gate", values: { target: "drive/upload" } });
    expect(r("agent_message", "Sari → Budi")).toEqual({ key: "agent_message", values: { name: "Sari → Budi" } });
    expect(r("error", "run_stalled")).toEqual({ key: "stopped_stalled", values: {} });
    expect(r("system", "something")).toEqual({ key: "other", values: { name: "something" } });
    expect(r("tool", "send_email", { to: "x".repeat(200) }).values.to!.length).toBeLessThanOrEqual(80);
  });
});
