import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appEnvironments, appReleases, approvals, apps, db, employees, members, repositories, servers, tasks, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, BUILTIN_TOOLS, requestPreviewPayloadSchema, type RequestPreviewPayload } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { GET as getApp } from "@/app/api/apps/[id]/route";
import { GET as getTask } from "@/app/api/tasks/[id]/route";
import { GET as getTaskCode } from "@/app/api/tasks/[id]/code/route";
import { GET as getTemplates } from "@/app/api/templates/route";
import { describeReceipt } from "@/lib/step-labels";
import type { ReleaseOrigin, TaskPreview } from "@/lib/app-previews";
import { call, callWithParams, jar, queueModule, resetBrowser } from "./browser";

const PASSWORD = "pw-123456-previews";
const SHA = "c".repeat(40);
const SHA_OLD = "d".repeat(40);

beforeEach(() => {
  resetBrowser();
  vi.mocked(queueModule.q.action).mockClear();
});

async function signIn(role: "ADMIN" | "VIEWER", wsId?: string) {
  const ws = wsId ?? (await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning())[0]!.id;
  const email = `p-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: `${role} Ayu`, passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: ws, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  return { userId: u!.id, wsId: ws };
}

/** a Developer's task that pushed agent/<task> and asked for a preview of an app linked to its repository */
async function previewFixture(wsId: string, userId: string) {
  const base = `p${randomUUID().slice(0, 6)}.example.com`;
  const [server] = await db.insert(servers).values({ workspaceId: wsId, name: `srv-${base}`, host: "45.77.10.20", port: 22, baseDomain: base, status: "ready" }).returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: wsId, name: `repo-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/guestbook.git" }).returning();
  const slug = `guestbook-${randomUUID().slice(0, 4)}`;
  const [row] = await db.insert(apps).values({ workspaceId: wsId, repositoryId: repo!.id, name: `Guestbook ${slug}`, slug }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: row!.id, workspaceId: wsId, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.${base}`, port: APP_PORT_MIN + 400 })
    .returning();
  const app = { ...row!, domain: env!.domain, env: env! };
  const [dev] = await db.insert(employees).values({ workspaceId: wsId, name: "Raka", role: "Developer", model: "m" }).returning();
  const [task] = await db.insert(tasks).values({ workspaceId: wsId, title: "Add a guestbook", assigneeId: dev!.id, status: "AWAITING_APPROVAL", repositoryId: repo!.id }).returning();
  const payload: RequestPreviewPayload = {
    appId: app!.id,
    appName: app!.name,
    url: `https://${app!.domain}`,
    serverName: server!.name,
    repositoryId: repo!.id,
    repository: repo!.name,
    branch: `agent/${task!.id}`,
    commit: SHA,
    commitSubject: "Add the guestbook form",
    currentCommit: SHA_OLD,
    commits: [{ sha: SHA, subject: "Add the guestbook form" }],
    files: [{ path: "app/page.tsx", added: 40, removed: 3 }],
    filesTruncated: false,
    warnings: ["new_database"],
    manifest: { type: "nextjs", install: "pnpm install --frozen-lockfile", build: "pnpm build", start: "pnpm start -H 127.0.0.1 -p $PORT", health: "/api/health", database: true, memoryMb: 512, migrate: "pnpm migrate" },
    summary: "Guests can sign the book.",
  };
  expect(requestPreviewPayloadSchema.safeParse(payload).success).toBe(true);
  const [approval] = await db
    .insert(approvals)
    .values({ workspaceId: wsId, taskId: task!.id, employeeId: dev!.id, toolName: "request_preview", title: `Publish a preview of ${app!.name}`, payload: payload as unknown as Record<string, unknown> })
    .returning();
  const release = async (over: Partial<typeof appReleases.$inferInsert> = {}) =>
    (
      await db
        .insert(appReleases)
        .values({ appId: app!.id, workspaceId: wsId, environmentId: env!.id, commit: SHA, branch: `agent/${task!.id}`, commitSubject: "Add the guestbook form", trigger: "approval", approvalId: approval!.id, taskId: task!.id, createdBy: userId, ...over })
        .returning()
    )[0]!;
  return { server: server!, repo: repo!, app: app!, dev: dev!, task: task!, approval: approval!, payload, release };
}

const taskParams = (taskId: string) => ({ id: taskId });

interface EmployeesCatalog {
  toolCategories: Record<string, string>;
  tools: Record<string, { label: string; description: string }>;
  activity: { receipt: Record<string, string> };
}
const catalog = (locale: "en" | "id") => JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "messages", locale, "employees.json"), "utf8")) as EmployeesCatalog;
const en = catalog("en");
const id = catalog("id");

describe("request_preview approvals", () => {
  it("cannot be edited: Edit & approve is refused and the payload stays exactly as requested", async () => {
    const o = await signIn("ADMIN");
    const f = await previewFixture(o.wsId, o.userId);
    const tampered = { ...f.payload, commit: "e".repeat(40), url: "https://evil.example.com" };
    const r = await callWithParams(decide, "POST", `/api/approvals/${f.approval.id}/decide`, { decision: "edit_approve", editedPayload: tampered }, { id: f.approval.id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("preview_not_editable");
    const [after] = await db.select().from(approvals).where(eq(approvals.id, f.approval.id));
    expect(after).toMatchObject({ status: "PENDING", editedPayload: null });
    expect(after!.payload).toMatchObject({ commit: SHA, url: f.payload.url });
    expect(queueModule.q.action).not.toHaveBeenCalled();
  });

  it("is refused for Edit & approve even without an edited payload, and a plain approve queues the execution", async () => {
    const o = await signIn("ADMIN");
    const f = await previewFixture(o.wsId, o.userId);
    const bare = await callWithParams(decide, "POST", `/api/approvals/${f.approval.id}/decide`, { decision: "edit_approve" }, { id: f.approval.id });
    expect(bare.status).toBe(400);
    expect(bare.json.code).toBe("preview_not_editable");
    const ok = await callWithParams(decide, "POST", `/api/approvals/${f.approval.id}/decide`, { decision: "approve" }, { id: f.approval.id });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, f.approval.id));
    expect(after).toMatchObject({ status: "APPROVED", editedPayload: null, decidedBy: o.userId });
    expect(queueModule.q.action).toHaveBeenCalledWith({ kind: "execute_approval", approvalId: f.approval.id, workspaceId: o.wsId });
  });

  it("the task's code view lists the pending preview next to the push", async () => {
    const o = await signIn("VIEWER");
    const f = await previewFixture(o.wsId, o.userId);
    const r = await callWithParams(getTaskCode, "GET", `/api/tasks/${f.task.id}/code`, undefined, taskParams(f.task.id));
    expect(r.status).toBe(200);
    expect(r.json.approvals).toEqual([expect.objectContaining({ id: f.approval.id, toolName: "request_preview", status: "PENDING" })]);
  });
});

describe("task previews", () => {
  it("the task lists its preview releases newest first; the address only for the one deployed", async () => {
    const o = await signIn("VIEWER");
    const f = await previewFixture(o.wsId, o.userId);
    const failed = await f.release({ status: "failed", step: "build", error: "build failed", createdAt: new Date(Date.now() - 60_000), finishedAt: new Date() });
    const live = await f.release({ status: "deployed", step: "cleanup", warnings: ["new_database"], finishedAt: new Date() });
    const r = await callWithParams(getTask, "GET", `/api/tasks/${f.task.id}`, undefined, taskParams(f.task.id));
    expect(r.status).toBe(200);
    const previews = r.json.previews as TaskPreview[];
    expect(previews.map((p) => p.id)).toEqual([live.id, failed.id]);
    expect(previews[0]).toMatchObject({ appId: f.app.id, appName: f.app.name, status: "deployed", url: `https://${f.app.domain}`, approvalId: f.approval.id, commit: SHA, warnings: ["new_database"] });
    expect(previews[1]).toMatchObject({ status: "failed", step: "build", error: "build failed", url: null });
    // never the log or the manifest
    expect(JSON.stringify(previews)).not.toContain("log");
  });

  it("a task without previews returns an empty list", async () => {
    const o = await signIn("VIEWER");
    const [t] = await db.insert(tasks).values({ workspaceId: o.wsId, title: "Write a memo" }).returning();
    const r = await callWithParams(getTask, "GET", `/api/tasks/${t!.id}`, undefined, taskParams(t!.id));
    expect(r.status).toBe(200);
    expect(r.json.previews).toEqual([]);
  });

  it("workspace isolation: another workspace's releases never show on a task, and its tasks stay hidden", async () => {
    const a = await signIn("VIEWER");
    const fa = await previewFixture(a.wsId, a.userId);
    await fa.release({ status: "queued" });
    const b = await signIn("ADMIN");
    const fb = await previewFixture(b.wsId, b.userId);
    // a (corrupt) release of workspace B that points at A's task: A's task page must not show it
    await fb.release({ taskId: fa.task.id, approvalId: null, status: "deployed" });
    // B cannot read A's task (nor its previews)
    expect((await callWithParams(getTask, "GET", `/api/tasks/${fa.task.id}`, undefined, taskParams(fa.task.id))).status).toBe(404);
    // A sees only its own release
    jar.clear();
    const [ua] = await db.select().from(users).where(eq(users.id, a.userId));
    expect((await call(login, "POST", "/api/auth/login", { email: ua!.email, password: PASSWORD })).status).toBe(200);
    const r = await callWithParams(getTask, "GET", `/api/tasks/${fa.task.id}`, undefined, taskParams(fa.task.id));
    expect((r.json.previews as TaskPreview[]).map((p) => p.appId)).toEqual([fa.app.id]);
  });
});

describe("app releases: by <employee> via <task>", () => {
  it("an approval release names the task and its employee; a manual one has no origin", async () => {
    const o = await signIn("VIEWER");
    const f = await previewFixture(o.wsId, o.userId);
    const viaTask = await f.release({ status: "deployed" });
    await f.release({ trigger: "manual", approvalId: null, taskId: null, commit: SHA_OLD, createdAt: new Date(Date.now() - 3_600_000) });
    const r = await callWithParams(getApp, "GET", `/api/apps/${f.app.id}`, undefined, { id: f.app.id });
    expect(r.status).toBe(200);
    const releases = r.json.releases as { id: string; taskId: string | null; approvalId: string | null; createdByName: string | null }[];
    expect(releases.find((x) => x.id === viaTask.id)).toMatchObject({ taskId: f.task.id, approvalId: f.approval.id, createdByName: "VIEWER Ayu" });
    const origins = r.json.origins as Record<string, ReleaseOrigin>;
    expect(origins).toEqual({ [f.task.id]: { taskId: f.task.id, taskTitle: "Add a guestbook", employeeId: f.dev.id, employeeName: "Raka" } });
  });

  it("workspace isolation: a release pointing at another workspace's task gets no origin", async () => {
    const a = await signIn("ADMIN");
    const fa = await previewFixture(a.wsId, a.userId);
    const b = await signIn("ADMIN");
    const fb = await previewFixture(b.wsId, b.userId);
    await fb.release({ taskId: fa.task.id, approvalId: null });
    const r = await callWithParams(getApp, "GET", `/api/apps/${fb.app.id}`, undefined, { id: fb.app.id });
    expect(r.status).toBe(200);
    expect(r.json.origins).toEqual({});
    // task titles only ever reach the page through origins
    expect(JSON.stringify(r.json)).not.toContain(fa.task.title);
  });
});

describe("the two tools in the tool picker and activity", () => {
  it("the hire and settings pickers get list_apps (reversible) and request_preview (irreversible) under Code, in both languages", async () => {
    await signIn("VIEWER");
    const r = await call(getTemplates, "GET", "/api/templates");
    const tools = r.json.tools as typeof BUILTIN_TOOLS;
    expect(tools.find((x) => x.name === "list_apps")).toMatchObject({ class: "reversible", category: "code" });
    expect(tools.find((x) => x.name === "request_preview")).toMatchObject({ class: "irreversible", category: "code" });
    for (const cat of [en, id]) {
      expect(cat.toolCategories.code).toBeTruthy();
      expect(cat.tools.list_apps?.label).toBeTruthy();
      expect(cat.tools.request_preview?.label).toBeTruthy();
      // every builtin category the picker can show has a label
      for (const tool of BUILTIN_TOOLS) expect(cat.toolCategories[tool.category], tool.category).toBeTruthy();
    }
  });

  it("the Activity tab has its own wording for both", () => {
    expect(describeReceipt({ kind: "tool", name: "list_apps", input: {}, output: null })).toEqual({ key: "list_apps", values: {}, tool: "list_apps" });
    expect(describeReceipt({ kind: "tool", name: "simulated:request_preview", input: { appId: randomUUID() }, output: null })).toEqual({ key: "request_preview", values: {}, tool: "request_preview" });
    expect(en.activity.receipt.request_preview).toBeTruthy();
    expect(id.activity.receipt.list_apps).toBeTruthy();
  });
});
