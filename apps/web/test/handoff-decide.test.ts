import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { approvals, db, employees, members, teams, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { callWithParams, call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

describe("PRD handoff decision", () => {
  it("Edit & Approve of an older payload (made before divisions) can change the developer and repository but never the PRD text", async () => {
    const email = `d-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "ADMIN" });
    const [dev] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Dev", role: "Developer", model: "m" }).returning();
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: ws!.id, toolName: "handoff_prd", title: "PRD: x", payload: { title: "x", prd: "approved text", developerId: null, repositoryId: null } })
      .returning();
    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
    const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "edit_approve", editedPayload: { developerId: dev!.id, repositoryId: null, prd: "TAMPERED" } }, { id: a!.id });
    expect(r.status).toBe(200);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(after!.editedPayload).toMatchObject({ prd: "approved text", developerId: dev!.id });
  });

  it("Edit & Approve can send the PRD to another division of this workspace, never the PRD text or a foreign division", async () => {
    const email = `d-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    const [other] = await db.insert(workspaces).values({ name: "Other", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "ADMIN" });
    const [delivery, support] = await db.insert(teams).values([{ workspaceId: ws!.id, name: "Delivery" }, { workspaceId: ws!.id, name: "Support" }]).returning();
    const [foreign] = await db.insert(teams).values({ workspaceId: other!.id, name: "Theirs" }).returning();
    const payload = { prdDeliverableId: null, title: "x", prd: "approved text", teamId: delivery!.id, teamName: "Delivery", repositoryId: null, clientId: null, projectId: null, untrustedInput: false, resumeTaskId: null };
    const mk = async () => (await db.insert(approvals).values({ workspaceId: ws!.id, toolName: "handoff_prd", title: "PRD: x", payload }).returning())[0]!;
    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });

    const a = await mk();
    const bad = await callWithParams(decide, "POST", `/api/approvals/${a.id}/decide`, { decision: "edit_approve", editedPayload: { teamId: foreign!.id, repositoryId: null } }, { id: a.id });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("unknown_team");
    expect((await db.select().from(approvals).where(eq(approvals.id, a.id)))[0]!.status).toBe("PENDING");

    const r = await callWithParams(decide, "POST", `/api/approvals/${a.id}/decide`, { decision: "edit_approve", editedPayload: { teamId: support!.id, repositoryId: null, prd: "TAMPERED", teamName: "Spoofed" } }, { id: a.id });
    expect(r.status).toBe(200);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(after!.editedPayload).toMatchObject({ prd: "approved text", teamId: support!.id, teamName: "Support", resumeTaskId: null });
    expect(after!.editedPayload).not.toHaveProperty("developerId");
  });
});

describe("an approval of a task that is still working", () => {
  it("stays PENDING (409 approval_task_running) while the task runs or is queued, and expires only once the task ended", async () => {
    const { tasks } = await import("@wfos/db");
    const email = `d-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "ADMIN" });
    const [arif] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Arif", role: "Tech Lead", model: "m" }).returning();
    const [t] = await db.insert(tasks).values({ workspaceId: ws!.id, assigneeId: arif!.id, title: "Build", brief: "b", status: "RUNNING" }).returning();
    const [a] = await db.insert(approvals).values({ workspaceId: ws!.id, taskId: t!.id, employeeId: arif!.id, toolName: "bash", title: "$ pnpm add zod", payload: { command: "pnpm add zod" } }).returning();
    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
    const decideIt = () => callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "approve" }, { id: a!.id });

    for (const status of ["RUNNING", "QUEUED"] as const) {
      await db.update(tasks).set({ status }).where(eq(tasks.id, t!.id));
      const r = await decideIt();
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("approval_task_running");
      expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("PENDING");
    }
    await db.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, t!.id));
    const done = await decideIt();
    expect(done.json.code).toBe("approval_task_closed");
    expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("EXPIRED");
  });
});
