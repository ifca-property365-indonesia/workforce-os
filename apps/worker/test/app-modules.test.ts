import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { appDocuments, appDocumentTasks, appModules, appModuleTasks, approvals, apps, db, repositories, tasks } from "@wfos/db";
import { runTask } from "../src/runner/task";
import { startWaitingModuleWork } from "../src/runner/task-status";
import { modulesInCommit } from "../src/docs/app-module";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { mirrorPath, syncMirror } from "../src/runner/workspace/git";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

const PRD = "# PRD\n\n## Tujuan\n\nTim keuangan membuat dan melacak faktur pelanggan, dengan persetujuan manajer.\n";

async function setup() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const [app] = await db.insert(apps).values({ workspaceId: ws.id, name: "ERP", slug: `erp-${randomUUID().slice(0, 6)}` }).returning();
  const mod = (name: string, slug: string, summary = "") => db.insert(appModules).values({ workspaceId: ws.id, appId: app!.id, name, slug, summary }).returning().then((r) => r[0]!);
  return { ws, emp, app: app!, mod };
}
const prd = (s: Awaited<ReturnType<typeof setup>>, moduleId: string | null, content = PRD, version = 1) =>
  db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, moduleId, kind: "prd", version, title: "PRD", content, status: "approved" }).returning();
const save = (input: Record<string, unknown>): MockStep => ({ tool: "mcp__wfos__save_app_document", input });

describe("app modules (C8): employees' side", () => {
  it("a module PRD task writes that module's PRD, numbered per module, with the app's PRD and the other modules as data", async () => {
    const s = await setup();
    const faktur = await s.mod("Faktur", "faktur", "membuat dan mengirim faktur");
    await s.mod("Stok", "stok", "stok gudang");
    await prd(s, null, `# PRD ERP\n\n${PRD}`);
    const task = await makeTask(s.ws.id, s.emp.id, { title: "PRD modul: Faktur" });
    await db.insert(appDocumentTasks).values({ taskId: task.id, workspaceId: s.ws.id, appId: s.app.id, moduleId: faktur.id, kind: "prd" });
    const mock = mockRunner([save({ title: "PRD Faktur", content: `${PRD}## Layar\n- daftar faktur`, note: "first" }), { result: "Saved." }]);
    setQueryImpl(mock.query as QueryFn);
    await runTask(task.id);

    expect(mock.lastPrompt).toContain("Module PRD: Faktur (faktur) of ERP");
    expect(mock.lastPrompt).toContain("<app-prd-v1>");
    expect(mock.lastPrompt).toContain("- Stok (stok, draft): stok gudang");
    expect(mock.lastPrompt).toContain("membuat dan mengirim faktur");
    expect(mock.calls[0]!.output).toMatch(/Saved version 1 of the PRD of the module Faktur as a draft/);
    const mine = await db.select().from(appDocuments).where(eq(appDocuments.moduleId, faktur.id));
    expect(mine.map((d) => [d.version, d.status])).toEqual([[1, "draft"]]);
    // the app's own PRD is untouched (still its only version 1)
    expect((await db.select().from(appDocuments).where(and(eq(appDocuments.appId, s.app.id), isNull(appDocuments.moduleId)))).map((d) => d.status)).toEqual(["approved"]);
  });

  it("a build gets the module's PRD and the rules of working in one module; its subtasks too; list_app_modules shows the app", async () => {
    const s = await setup();
    const faktur = await s.mod("Faktur", "faktur");
    await s.mod("Stok", "stok", "stok gudang");
    await prd(s, faktur.id, `${PRD}## Kriteria\n- [ ] faktur bisa dikirim`);
    const build = await makeTask(s.ws.id, s.emp.id, { title: "Bangun modul: Faktur (ERP)" });
    await db.insert(appModuleTasks).values({ taskId: build.id, moduleId: faktur.id, workspaceId: s.ws.id, role: "build" });
    const mock = mockRunner([{ tool: "mcp__wfos__list_app_modules", input: {} }, { result: "Planned." }]);
    setQueryImpl(mock.query as QueryFn);
    await runTask(build.id);
    expect(mock.lastPrompt).toContain("## Module build: Faktur (faktur) of ERP");
    expect(mock.lastPrompt).toContain("<module-prd-v1>");
    expect(mock.lastPrompt).toContain("faktur bisa dikirim");
    expect(mock.lastPrompt).toContain("app/faktur/");
    expect(mock.lastPrompt).toContain("- Stok (stok, draft): stok gudang");
    const listed = JSON.parse(String(mock.calls[0]!.output)) as { app: string; modules: { slug: string; status: string; prdVersion: number | null }[] };
    expect(listed.app).toBe("ERP");
    expect(listed.modules).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "faktur", prdVersion: 1 }), expect.objectContaining({ slug: "stok", status: "draft" })]));

    // a subtask of the build (a team builds the module) is told it is part of that module's work
    const sub = await makeTask(s.ws.id, s.emp.id, { title: "UI faktur", parentTaskId: build.id });
    const mock2 = mockRunner([{ result: "Done." }]);
    setQueryImpl(mock2.query as QueryFn);
    await runTask(sub.id);
    expect(mock2.lastPrompt).toContain("part of that module's work");
    expect(mock2.lastPrompt).toContain("<module-prd-v1>");

    // an ordinary task has neither the module context nor the tool
    const plain = await makeTask(s.ws.id, s.emp.id, { title: "Something else" });
    const mock3 = mockRunner([{ tool: "mcp__wfos__list_app_modules", input: { appId: s.app.id } }, { result: "ok" }]);
    setQueryImpl(mock3.query as QueryFn);
    await runTask(plain.id);
    expect(mock3.lastPrompt).not.toContain("## Module build");
    expect(String(mock3.calls[0]!.output)).not.toContain("faktur");
  });

  it("the end of a module build starts the build that waited for the app", async () => {
    const s = await setup();
    const [repo] = await db.insert(repositories).values({ workspaceId: s.ws.id, name: `r-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/erp.git" }).returning();
    await db.update(apps).set({ repositoryId: repo!.id }).where(eq(apps.id, s.app.id));
    const a = await s.mod("A", "aa");
    const b = await s.mod("B", "bb");
    const first = await makeTask(s.ws.id, s.emp.id, { title: "Bangun A", status: "DONE", repositoryId: repo!.id });
    await db.insert(appModuleTasks).values({ taskId: first.id, moduleId: a.id, workspaceId: s.ws.id, role: "build" });
    await db.update(appModules).set({ pendingWork: { role: "change", employeeId: s.emp.id, teamId: null, note: "tambah filter", requestedBy: null, requestedAt: new Date().toISOString() } }).where(eq(appModules.id, b.id));

    await startWaitingModuleWork(first.id);
    const started = await db.select({ t: tasks, role: appModuleTasks.role }).from(appModuleTasks).innerJoin(tasks, eq(tasks.id, appModuleTasks.taskId)).where(eq(appModuleTasks.moduleId, b.id));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ role: "change", t: { assigneeId: s.emp.id, repositoryId: repo!.id, status: "QUEUED" } });
    expect(started[0]!.t.brief).toContain("tambah filter");
    expect((await db.select().from(appModules).where(eq(appModules.id, b.id)))[0]!.pendingWork).toBeNull();
    // a task that is no module's work changes nothing
    await startWaitingModuleWork((await makeTask(s.ws.id, s.emp.id)).id);
  });
});

describe("app modules (C8b): which modules a release contains", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wfos-modules-"));
  const remote = path.join(tmp, "remote.git");
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, env: ENV }).toString().trim();
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("a module is in a commit when one of its tasks' (or subtasks') pushed heads is an ancestor of it", async () => {
    const s = await setup();
    g(["init", "--bare", "-q", "-b", "main", remote]);
    const seed = path.join(tmp, "seed");
    g(["init", "-q", "-b", "main", seed]);
    writeFileSync(path.join(seed, "README.md"), "erp\n");
    g(["add", "-A"], seed);
    g(["commit", "-q", "-m", "initial"], seed);
    g(["push", "-q", remote, "main"], seed);
    const initial = g(["rev-parse", "HEAD"], seed);
    const [row] = await db.insert(repositories).values({ workspaceId: s.ws.id, name: "erp", provider: "git", url: remote, defaultBranch: "main" }).returning();
    const repo = { id: row!.id, provider: "git" as const, url: remote, defaultBranch: "main", token: null };
    await db.update(apps).set({ repositoryId: repo.id }).where(eq(apps.id, s.app.id));
    await syncMirror(repo);

    const work = async (taskId: string, file: string, from: string) => {
      const dir = path.join(tmp, `w-${taskId}`);
      g(["clone", "-q", remote, dir]);
      g(["fetch", "-q", mirrorPath(repo.id), "+refs/agent/*:refs/agent/*"], dir);
      g(["checkout", "-q", "-B", "work", from], dir);
      writeFileSync(path.join(dir, file), `${file}\n`);
      g(["add", "-A"], dir);
      g(["commit", "-q", "-m", file], dir);
      const head = g(["rev-parse", "HEAD"], dir);
      g(["push", "-q", mirrorPath(repo.id), `HEAD:refs/agent/${taskId}`], dir);
      await db.insert(approvals).values({ workspaceId: s.ws.id, taskId, employeeId: s.emp.id, toolName: "git_push", title: "push", payload: { head, branch: `agent/${taskId}` }, status: "EXECUTED" });
      return head;
    };
    const faktur = await s.mod("Faktur", "faktur");
    const stok = await s.mod("Stok", "stok");
    const lain = await s.mod("Lain", "lain");
    // faktur: built by a team, the subtask pushed
    const parent = await makeTask(s.ws.id, s.emp.id, { title: "Bangun Faktur", status: "DONE", repositoryId: repo.id });
    await db.insert(appModuleTasks).values({ taskId: parent.id, moduleId: faktur.id, workspaceId: s.ws.id, role: "build" });
    const child = await makeTask(s.ws.id, s.emp.id, { title: "UI faktur", status: "DONE", repositoryId: repo.id, parentTaskId: parent.id });
    const fakturHead = await work(child.id, "faktur.txt", initial);
    // stok: pushed on top of faktur's work
    const stokTask = await makeTask(s.ws.id, s.emp.id, { title: "Bangun Stok", status: "DONE", repositoryId: repo.id });
    await db.insert(appModuleTasks).values({ taskId: stokTask.id, moduleId: stok.id, workspaceId: s.ws.id, role: "build" });
    const stokHead = await work(stokTask.id, "stok.txt", fakturHead);
    // lain: only its PRD task pushed something (a PRD task never counts as the module's code)
    const prdTask = await makeTask(s.ws.id, s.emp.id, { title: "PRD Lain", status: "DONE", repositoryId: repo.id });
    await db.insert(appModuleTasks).values({ taskId: prdTask.id, moduleId: lain.id, workspaceId: s.ws.id, role: "prd" });
    const lainHead = await work(prdTask.id, "lain.txt", stokHead);

    const mirror = mirrorPath(repo.id);
    const app = { id: s.app.id, repositoryId: repo.id };
    expect(await modulesInCommit(s.ws.id, app, mirror, fakturHead)).toEqual([faktur.id]);
    expect(await modulesInCommit(s.ws.id, app, mirror, stokHead)).toEqual([faktur.id, stok.id].sort());
    expect(await modulesInCommit(s.ws.id, app, mirror, lainHead)).toEqual([faktur.id, stok.id].sort());
    expect(await modulesInCommit(s.ws.id, app, mirror, initial)).toEqual([]);
  });
});
