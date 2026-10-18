import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, apps, appTests, auditLog, db, employees, members, servers, tasks, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listTests, POST as startTest } from "@/app/api/apps/[id]/tests/route";
import { POST as handle } from "@/app/api/apps/[id]/tests/[testId]/route";
import { GET as screenshot } from "@/app/api/apps/[id]/tests/[testId]/screenshots/[n]/route";
import { GET as inbox } from "@/app/api/inbox/route";
import { serverEnv } from "@/lib/server/env";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup(role: Role, o: { running?: boolean } = {}) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `t-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "P", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [qa] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Gilang", role: "QA Tester", model: "m" }).returning();
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.20", baseDomain: "p.example.com", status: "ready" }).returning();
  const slug = `at-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws!.id, name: "Procurement", slug }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId: ws!.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 520 + Math.floor(Math.random() * 250), status: o.running === false ? "stopped" : "running" })
    .returning();
  const [rel] = await db.insert(appReleases).values({ appId: app!.id, workspaceId: ws!.id, environmentId: env!.id, commit: "a".repeat(40), branch: "main", status: "deployed", trigger: "manual" }).returning();
  if (o.running !== false) await db.update(appEnvironments).set({ currentReleaseId: rel!.id }).where(eq(appEnvironments.id, env!.id));
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, app: app!, env: env!, qa: qa! };
}
const at = (appId: string, sub = "") => `/api/apps/${appId}/tests${sub}`;

describe("app tests (C3)", () => {
  it("a member starts a test of the running preview: a task for the tester, the commit recorded, audited; one at a time", async () => {
    const { ws, app, qa } = await setup("MEMBER");
    const r = await callWithParams(startTest, "POST", at(app.id), { employeeId: qa.id, focus: "approval flow", roles: ["approver"] }, { id: app.id });
    expect(r.status).toBe(200);
    const [test] = await db.select().from(appTests).where(eq(appTests.id, r.json.testId as string));
    expect(test).toMatchObject({ status: "running", commit: "a".repeat(40), focus: "approval flow", roles: ["approver"], taskId: r.json.taskId });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(task).toMatchObject({ assigneeId: qa.id, workspaceId: ws.id, status: "QUEUED" });
    expect(task!.brief).toContain("approval flow");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "app.test_started"), eq(auditLog.targetId, app.id)))).toHaveLength(1);

    const again = await callWithParams(startTest, "POST", at(app.id), { employeeId: qa.id }, { id: app.id });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("app_test_running");
  });

  it("refuses a stopped preview and a tester from another workspace", async () => {
    const stopped = await setup("MEMBER", { running: false });
    const r = await callWithParams(startTest, "POST", at(stopped.app.id), { employeeId: stopped.qa.id }, { id: stopped.app.id });
    expect(r.json.code).toBe("preview_not_running");
    const other = await setup("MEMBER");
    const mine = await setup("MEMBER");
    expect((await callWithParams(startTest, "POST", at(mine.app.id), { employeeId: other.qa.id }, { id: mine.app.id })).json.code).toBe("tester_not_found");
  });

  it("lists tests with findings; a running test whose task ended shows as an error; findings wait in Needs a decision until handled", async () => {
    const { ws, app, env, qa } = await setup("MEMBER");
    const [cancelled] = await db.insert(tasks).values({ workspaceId: ws.id, title: "t1", assigneeId: qa.id, status: "CANCELLED" }).returning();
    await db.insert(appTests).values({ workspaceId: ws.id, appId: app.id, environmentId: env.id, taskId: cancelled!.id, createdAt: new Date(Date.now() - 60_000) });
    const [done] = await db.insert(tasks).values({ workspaceId: ws.id, title: "t2", assigneeId: qa.id, status: "DONE" }).returning();
    const finding = { id: randomUUID(), title: "Requester can approve", severity: "high" as const, role: "requester", path: "/approvals", steps: "open /approvals", expected: "403", actual: "buttons (#2)" };
    const [withFindings] = await db
      .insert(appTests)
      .values({ workspaceId: ws.id, appId: app.id, environmentId: env.id, taskId: done!.id, status: "findings", summary: "one high", findings: [finding], commit: "a".repeat(40), finishedAt: new Date() })
      .returning();

    const r = await callWithParams(listTests, "GET", at(app.id), undefined, { id: app.id });
    const rows = r.json.tests as { id: string; status: string; findings: unknown[]; task: { tester: string } }[];
    expect(rows.map((x) => x.status)).toEqual(["findings", "error"]);
    expect(rows[0]).toMatchObject({ id: withFindings!.id, findings: [finding], task: { tester: "Gilang" } });

    const box = await callWithParams(inbox, "GET", "/api/inbox", undefined, {});
    expect((box.json.items as { kind: string; id: string; high?: number }[]).find((x) => x.kind === "test_findings")).toMatchObject({ id: withFindings!.id, high: 1, findings: 1 });
    expect(box.json).toMatchObject({ counts: { test_findings: 1 } });

    expect((await callWithParams(handle, "POST", at(app.id, `/${withFindings!.id}`), { action: "handled" }, { id: app.id, testId: withFindings!.id })).status).toBe(200);
    expect((await callWithParams(handle, "POST", at(app.id, `/${withFindings!.id}`), { action: "handled" }, { id: app.id, testId: withFindings!.id })).status).toBe(404);
    const after = await callWithParams(inbox, "GET", "/api/inbox", undefined, {});
    expect(after.json).toMatchObject({ counts: { test_findings: 0 } });
  });

  it("serves a test's screenshots to members of its workspace only", async () => {
    const { ws, app, env } = await setup("MEMBER");
    const [t] = await db.insert(appTests).values({ workspaceId: ws.id, appId: app.id, environmentId: env.id }).returning();
    const dir = path.resolve(serverEnv.storageDir, "app-tests", t!.id);
    await mkdir(dir, { recursive: true });
    // (the test helper reads every body as JSON: the stored bytes are JSON text here)
    await writeFile(path.join(dir, "2.png"), Buffer.from('{"png":2}'));
    const ok = await callWithParams(screenshot, "GET", at(app.id, `/${t!.id}/screenshots/2`), undefined, { id: app.id, testId: t!.id, n: "2" });
    expect(ok).toEqual({ status: 200, json: { png: 2 } });
    expect((await callWithParams(screenshot, "GET", at(app.id, `/${t!.id}/screenshots/3`), undefined, { id: app.id, testId: t!.id, n: "3" })).status).toBe(404);
    expect((await callWithParams(screenshot, "GET", at(app.id, `/${t!.id}/screenshots/..%2F1`), undefined, { id: app.id, testId: t!.id, n: "../1" })).status).toBe(404);
    const other = await setup("MEMBER");
    expect((await callWithParams(screenshot, "GET", at(app.id, `/${t!.id}/screenshots/2`), undefined, { id: app.id, testId: t!.id, n: "2" })).status).toBe(404);
    void other;
  });
});
