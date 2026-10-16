import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, db, employees, members, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as inbox } from "@/app/api/approvals/route";
import { call, jar, resetBrowser } from "./browser";

const PASSWORD = "pw-123456-inbox";
beforeEach(() => resetBrowser());

describe("approvals inbox", () => {
  it("fourth trial (2026-10-16): an approval of a task whose employee is still working is not shown or counted until the run ends", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    const email = `i-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "Owner", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "OWNER" });
    jar.clear();
    expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
    const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Arif", role: "Tech Lead", model: "m" }).returning();
    const [t] = await db.insert(tasks).values({ workspaceId: ws!.id, assigneeId: emp!.id, title: "Fix nav", brief: "b", status: "RUNNING" }).returning();
    const [held] = await db.insert(approvals).values({ workspaceId: ws!.id, taskId: t!.id, employeeId: emp!.id, toolName: "bash", title: "$ git fetch upstream", payload: { command: "git fetch upstream" } }).returning();
    // a chat approval (no task) is always decidable
    const [chat] = await db.insert(approvals).values({ workspaceId: ws!.id, employeeId: emp!.id, toolName: "send_email", title: "Email", payload: {} }).returning();

    const pending = async () => (await call(inbox, "GET", "/api/approvals?status=PENDING")).json as { approvals: { id: string }[]; waiting: number };
    expect(await pending()).toMatchObject({ approvals: [{ id: chat!.id }], waiting: 1 });

    await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, t!.id));
    const after = await pending();
    expect(after.approvals.map((a) => a.id).sort()).toEqual([held!.id, chat!.id].sort());
    expect(after.waiting).toBe(0);
  });
});
