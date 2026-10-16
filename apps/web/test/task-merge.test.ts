import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, db, employees, members, repositories, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as mergeRoute } from "@/app/api/tasks/[id]/merge/route";
import { GET as codeRoute } from "@/app/api/tasks/[id]/code/route";
import { GET as unmergedRoute } from "@/app/api/repositories/[id]/unmerged/route";
import { q } from "@/lib/server/queue";
import { callWithParams, call, jar, resetBrowser } from "./browser";

const PASSWORD = "pw-123456-merge";
const sha = (c: string) => c.repeat(40);

beforeEach(() => resetBrowser());

async function setup(role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `m-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "Person", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Arif", role: "Tech Lead", model: "m" }).returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: ws!.id, name: "app", provider: "github", url: "https://github.com/x/app.git" }).returning();
  return { ws: ws!, user: u!, emp: emp!, repo: repo! };
}

/** a task on the repository whose work the platform pushed (an executed git_push of `head`) */
async function pushed(s: Awaited<ReturnType<typeof setup>>, head: string, status: "DONE" | "RUNNING" = "DONE") {
  const [t] = await db.insert(tasks).values({ workspaceId: s.ws.id, assigneeId: s.emp.id, title: `Work ${head.slice(0, 4)}`, brief: "b", status, repositoryId: s.repo.id }).returning();
  await db.insert(approvals).values({ workspaceId: s.ws.id, taskId: t!.id, employeeId: s.emp.id, toolName: "git_push", title: "push", payload: { repositoryId: s.repo.id, head, branch: `agent/${t!.id}` }, status: "EXECUTED" });
  return t!;
}

const decide = (taskId: string, body: Record<string, unknown>) => callWithParams(mergeRoute, "POST", `/api/tasks/${taskId}/merge`, body, { id: taskId });

describe("merge a task's pushed work into the default branch", () => {
  it("a person's merge becomes an approved merge_branch for the worker, audited, once per version", async () => {
    const s = await setup();
    const t = await pushed(s, sha("a"));
    const code = await callWithParams(codeRoute, "GET", "/x", undefined, { id: t.id });
    expect(code.json.merge).toMatchObject({ head: sha("a"), state: "unmerged", branch: `agent/${t.id}` });

    expect((await decide(t.id, { decision: "merge", head: sha("b") })).json.code).toBe("merge_head_changed");
    const r = await decide(t.id, { decision: "merge", head: sha("a") });
    expect(r.status).toBe(200);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, r.json.approvalId as string));
    expect(a).toMatchObject({ toolName: "merge_branch", status: "APPROVED", decidedBy: s.user.id, taskId: t.id, payload: { head: sha("a"), base: "main", repositoryId: s.repo.id } });
    expect(q.action).toHaveBeenCalledWith({ kind: "execute_approval", approvalId: a!.id, workspaceId: s.ws.id });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.targetId, t.id), eq(auditLog.action, "task.merge_approved")))).toHaveLength(1);

    expect((await decide(t.id, { decision: "merge", head: sha("a") })).json.code).toBe("merge_in_progress");
    const list = await callWithParams(unmergedRoute, "GET", "/x", undefined, { id: s.repo.id });
    expect(list.json.work).toMatchObject([{ taskId: t.id, state: "pending" }]);

    await db.update(approvals).set({ status: "EXECUTED", executionResult: { ok: true, summary: "merged", details: { commit: sha("c") } } }).where(eq(approvals.id, a!.id));
    expect((await decide(t.id, { decision: "merge", head: sha("a") })).json.code).toBe("merge_already_done");
    expect((await callWithParams(unmergedRoute, "GET", "/x", undefined, { id: s.repo.id })).json.work).toEqual([]);
    expect((await callWithParams(codeRoute, "GET", "/x", undefined, { id: t.id })).json.merge).toMatchObject({ state: "merged", commit: sha("c") });
  });

  it("leaving a version out is recorded and drops it from the waiting list; a new push is waiting again", async () => {
    const s = await setup("ADMIN");
    const t = await pushed(s, sha("d"));
    const r = await decide(t.id, { decision: "skip", head: sha("d"), note: "superseded by v2" });
    expect(r.status).toBe(200);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, r.json.approvalId as string));
    expect(a).toMatchObject({ status: "REJECTED", feedback: "superseded by v2" });
    expect(q.action).not.toHaveBeenCalled();
    expect((await callWithParams(unmergedRoute, "GET", "/x", undefined, { id: s.repo.id })).json.work).toEqual([]);

    await db.insert(approvals).values({ workspaceId: s.ws.id, taskId: t.id, employeeId: s.emp.id, toolName: "git_push", title: "push", payload: { repositoryId: s.repo.id, head: sha("e"), branch: `agent/${t.id}` }, status: "EXECUTED", createdAt: new Date(Date.now() + 1000) });
    expect((await callWithParams(unmergedRoute, "GET", "/x", undefined, { id: s.repo.id })).json.work).toMatchObject([{ taskId: t.id, head: sha("e"), state: "unmerged" }]);
  });

  it("only finished, pushed work of an Admin's own workspace; Members cannot merge", async () => {
    const s = await setup();
    const running = await pushed(s, sha("f"), "RUNNING");
    expect((await decide(running.id, { decision: "merge", head: sha("f") })).json.code).toBe("merge_task_not_done");
    const [bare] = await db.insert(tasks).values({ workspaceId: s.ws.id, title: "nothing", brief: "b", status: "DONE", repositoryId: s.repo.id }).returning();
    expect((await decide(bare!.id, { decision: "merge", head: sha("f") })).json.code).toBe("merge_nothing_pushed");
    const done = await pushed(s, sha("1"));
    // an Owner of another workspace does not see it
    await setup();
    expect((await decide(done.id, { decision: "merge", head: sha("1") })).status).toBe(404);
    const m = await setup("MEMBER");
    const own = await pushed(m, sha("2"));
    expect((await decide(own.id, { decision: "merge", head: sha("2") })).status).toBe(403);
  });
});
