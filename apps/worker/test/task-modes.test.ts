import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, steps, tasks } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { setQueryImpl } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { warnBudgetNearCap } from "../src/guards/budget";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

const allowListed = {
  autonomyLevel: "CLOSE" as const,
  toolPermissions: [{ tool: "send_email", enabled: true }],
  allowList: [{ tool: "send_email", recipientDomains: ["client.co.id"], clientIds: [], note: "" }],
};
const email = { to: ["ana@client.co.id"], subject: "Status", body: "Weekly status." };

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("work mode (P4)", () => {
  it("a plan-only task is told so and its allow-listed email is refused, nothing sent", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, allowListed);
    const task = await makeTask(ws.id, emp.id);
    await db.update(tasks).set({ workMode: "plan" }).where(eq(tasks.id, task.id));
    const mock = mockRunner([{ tool: "mcp__wfos__send_email", input: email }, { result: "Plan: 1. email Ana" }]);
    setQueryImpl(mock.query);
    await runTask(task.id);
    expect(mock.lastPrompt).toContain("This task is plan-only");
    expect(mock.calls[0]!.output).toMatch(/plan-only: no actions/);
    expect(transport.mails).toHaveLength(0);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe("DONE");
  });
});

describe("budget warning at 80 % (P5)", () => {
  it("warns once per employee and day between 80 % and the cap", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id, { dailyBudget: 100 });
    await db.insert(steps).values({ workspaceId: ws.id, employeeId: emp.id, kind: "llm", name: "x", credits: 70 });
    expect(await warnBudgetNearCap(ws.id, emp.id)).toBe(false);
    await db.insert(steps).values({ workspaceId: ws.id, employeeId: emp.id, kind: "llm", name: "x", credits: 15 });
    expect(await warnBudgetNearCap(ws.id, emp.id)).toBe(true);
    expect(await warnBudgetNearCap(ws.id, emp.id)).toBe(false);
    const notes = transport.queued.filter((j) => j.name === "notify").map((j) => j.data as { subject: string; notificationKind: string });
    expect(notes).toEqual([expect.objectContaining({ notificationKind: "limits", subject: expect.stringMatching(/85% of today's budget/) })]);
  });
});
