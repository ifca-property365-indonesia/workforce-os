import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  appDocuments,
  appDocumentTasks,
  appEnvironments,
  appModules,
  appModuleTasks,
  appReleases,
  approvals,
  apps,
  db,
  employees,
  members,
  repositories,
  servers,
  takeQueuedModuleWork,
  tasks,
  users,
  workspaces,
} from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listDocs } from "@/app/api/apps/[id]/documents/route";
import { POST as decide } from "@/app/api/apps/[id]/documents/[docId]/route";
import { GET as listModules, POST as addModule } from "@/app/api/apps/[id]/modules/route";
import { GET as getModule, PATCH as patchModule } from "@/app/api/apps/[id]/modules/[moduleId]/route";
import { POST as askPrd } from "@/app/api/apps/[id]/modules/[moduleId]/prd/route";
import { POST as importPrd } from "@/app/api/apps/[id]/modules/[moduleId]/prd/import/route";
import { DELETE as unqueue, POST as work } from "@/app/api/apps/[id]/modules/[moduleId]/work/route";
import { GET as candidates, POST as register } from "@/app/api/apps/[id]/modules/[moduleId]/register/route";
import { GET as inbox } from "@/app/api/inbox/route";
import { POST as taskAction } from "@/app/api/tasks/[id]/actions/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

const PRD = "# PRD Faktur\n\n## Tujuan\n\nTim keuangan membuat, mengirim, dan melacak faktur pelanggan.\n";
const head = () => randomUUID().replace(/-/g, "").padEnd(40, "a").slice(0, 40);

async function setup(role: Role, opts: { repository?: boolean } = { repository: true }) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `m-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "Owner", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [pm] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Pratiwi", role: "Project Manager", model: "m" }).returning();
  const [dev] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Citra", role: "Frontend Developer", model: "m", executionMode: "workspace" }).returning();
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.21", baseDomain: "p.example.com", status: "ready" }).returning();
  const [repo] = opts.repository
    ? await db.insert(repositories).values({ workspaceId: ws!.id, name: `repo-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/erp.git", defaultBranch: "main" }).returning()
    : [];
  const slug = `md-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws!.id, name: "ERP", slug, repositoryId: repo?.id ?? null }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId: ws!.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 600 + Math.floor(Math.random() * 190) })
    .returning();
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, user: u!, app: app!, env: env!, repo: repo ?? null, pm: pm!, dev: dev! };
}
type S = Awaited<ReturnType<typeof setup>>;
const at = (appId: string, sub = "") => `/api/apps/${appId}/modules${sub}`;
const mod = (s: S, name: string, slug: string) =>
  db.insert(appModules).values({ workspaceId: s.ws.id, appId: s.app.id, name, slug }).returning().then((r) => r[0]!);
const prd = (s: S, moduleId: string | null, v: Partial<typeof appDocuments.$inferInsert> = {}) =>
  db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, moduleId, kind: "prd", version: 1, title: "PRD", content: PRD, status: "approved", ...v }).returning().then((r) => r[0]!);
const views = async (s: S) => (await callWithParams(listModules, "GET", at(s.app.id), undefined, { id: s.app.id })).json.modules as { id: string; status: string; pending: unknown; active: { taskId: string } | null; inLive: boolean }[];

describe("app modules (C8)", () => {
  it("a member adds a module: technical name from the name, a PRD task for exactly that module; names are unique per app", async () => {
    const s = await setup("MEMBER");
    const r = await callWithParams(addModule, "POST", at(s.app.id), { name: "Laporan Keuangan", summary: "ringkasan bulanan untuk direksi", writerId: s.pm.id }, { id: s.app.id });
    expect(r.status).toBe(200);
    expect(r.json.slug).toBe("laporan-keuangan");
    const [link] = await db.select().from(appDocumentTasks).where(eq(appDocumentTasks.taskId, r.json.taskId as string));
    expect(link).toMatchObject({ appId: s.app.id, moduleId: r.json.id, kind: "prd" });
    const [role] = await db.select().from(appModuleTasks).where(eq(appModuleTasks.taskId, r.json.taskId as string));
    expect(role).toMatchObject({ moduleId: r.json.id, role: "prd" });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(task).toMatchObject({ assigneeId: s.pm.id, status: "QUEUED", repositoryId: null });
    expect((await views(s))[0]).toMatchObject({ status: "draft" });

    const again = await callWithParams(addModule, "POST", at(s.app.id), { name: "Laporan keuangan!" }, { id: s.app.id });
    expect(again.json.code).toBe("app_module_slug_taken");
    expect((await callWithParams(addModule, "POST", at(s.app.id), { name: "Faktur" }, { id: s.app.id })).json).toMatchObject({ slug: "faktur", taskId: null });
  });

  it("a module's PRD is versioned and approved on its own: the app's PRD and other modules stay as they are", async () => {
    const s = await setup("ADMIN");
    const a = await mod(s, "Faktur", "faktur");
    const b = await mod(s, "Stok", "stok");
    const appPrd = await prd(s, null);
    const a1 = await prd(s, a.id);
    await prd(s, b.id);
    const a2 = await prd(s, a.id, { version: 2, status: "draft", content: `${PRD}\n## Baru\n` });
    expect((await callWithParams(decide, "POST", `/api/apps/${s.app.id}/documents/${a2.id}`, { action: "approve" }, { id: s.app.id, docId: a2.id })).status).toBe(200);
    const rows = await db.select().from(appDocuments).where(eq(appDocuments.appId, s.app.id)).orderBy(asc(appDocuments.createdAt));
    const status = (id: string) => rows.find((r) => r.id === id)!.status;
    expect([status(appPrd.id), status(a1.id), status(a2.id)]).toEqual(["approved", "superseded", "approved"]);
    expect(rows.filter((r) => r.moduleId === b.id).map((r) => r.status)).toEqual(["approved"]);
    // the app's documents leave module PRDs out
    const docs = await callWithParams(listDocs, "GET", `/api/apps/${s.app.id}/documents`, undefined, { id: s.app.id });
    expect((docs.json.kinds as { prd: { versions: { id: string }[] } }).prd.versions.map((v) => v.id)).toEqual([appPrd.id]);
    const one = await callWithParams(getModule, "GET", at(s.app.id, `/${a.id}`), undefined, { id: s.app.id, moduleId: a.id });
    expect((one.json.prd as { version: number; status: string }[]).map((v) => [v.version, v.status])).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);
    expect(one.json.module).toMatchObject({ status: "ready", prd: { approved: { version: 2 }, draft: null } });
  });

  it("a build needs an approved PRD and a repository; one runs per app, the next waits and starts when it ends", async () => {
    const s = await setup("ADMIN");
    const a = await mod(s, "Faktur", "faktur");
    const b = await mod(s, "Stok", "stok");
    expect((await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: a.id })).json.code).toBe("app_module_no_prd");
    await prd(s, a.id);
    await prd(s, b.id);

    const first = await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id, note: "pakai komponen tabel yang ada" }, { id: s.app.id, moduleId: a.id });
    expect(first.status).toBe(200);
    expect(first.json.waitingFor).toBeNull();
    const [built] = await db.select().from(tasks).where(eq(tasks.id, first.json.taskId as string));
    expect(built).toMatchObject({ assigneeId: s.dev.id, repositoryId: s.repo!.id, status: "QUEUED" });
    expect(built!.brief).toContain("pakai komponen tabel yang ada");

    const second = await callWithParams(work, "POST", at(s.app.id, `/${b.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: b.id });
    expect(second.json).toEqual({ taskId: null, waitingFor: built!.title });
    let v = await views(s);
    expect(v.find((m) => m.id === a.id)).toMatchObject({ status: "building", active: { taskId: built!.id } });
    expect(v.find((m) => m.id === b.id)).toMatchObject({ status: "ready", pending: expect.objectContaining({ role: "build" }) });

    // nothing starts while the first one runs
    expect((await takeQueuedModuleWork(db, s.ws.id, s.app.id)).task).toBeNull();
    await db.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, built!.id));
    const next = await takeQueuedModuleWork(db, s.ws.id, s.app.id);
    expect(next.task).toMatchObject({ assigneeId: s.dev.id, repositoryId: s.repo!.id });
    v = await views(s);
    expect(v.find((m) => m.id === b.id)).toMatchObject({ status: "building", pending: null });
    // a change says what changes
    const bad = await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "change", employeeId: s.dev.id, note: "x" }, { id: s.app.id, moduleId: a.id });
    expect(bad.status).toBe(400);
  });

  it("cancelling the running build from the task frees the app: the waiting build starts", async () => {
    const s = await setup("ADMIN");
    const [a, b] = [await mod(s, "A", "aa"), await mod(s, "B", "bb")];
    await prd(s, a.id);
    await prd(s, b.id);
    const first = await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: a.id });
    await callWithParams(work, "POST", at(s.app.id, `/${b.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: b.id });
    const taskId = first.json.taskId as string;
    expect((await callWithParams(taskAction, "POST", `/api/tasks/${taskId}/actions`, { action: "cancel" }, { id: taskId })).status).toBe(200);
    const v = await views(s);
    expect(v.find((m) => m.id === b.id)).toMatchObject({ status: "building", pending: null });
    expect(v.find((m) => m.id === a.id)).toMatchObject({ status: "ready", active: null });
  });

  it("a waiting request that cannot start is dropped and does not block the next one", async () => {
    const s = await setup("ADMIN");
    const [a, b, c] = [await mod(s, "A", "aa"), await mod(s, "B", "bb"), await mod(s, "C", "cc")];
    for (const m of [a, b, c]) await prd(s, m.id);
    await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: a.id });
    await callWithParams(work, "POST", at(s.app.id, `/${b.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: b.id });
    await callWithParams(work, "POST", at(s.app.id, `/${c.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: c.id });
    // b's request names an employee that no longer exists: createTask refuses it
    await db.update(appModules).set({ pendingWork: { role: "build", employeeId: randomUUID(), teamId: null, note: "", requestedBy: null, requestedAt: new Date(0).toISOString() } }).where(eq(appModules.id, b.id));
    await db.update(tasks).set({ status: "DONE" }).where(eq(tasks.repositoryId, s.repo!.id));
    const r1 = await takeQueuedModuleWork(db, s.ws.id, s.app.id);
    expect(r1).toMatchObject({ task: null, dropped: { moduleId: b.id } });
    const r2 = await takeQueuedModuleWork(db, s.ws.id, s.app.id);
    expect(r2.task).toMatchObject({ assigneeId: s.dev.id });
    // only who can change code builds: a non-Workspace employee is refused
    expect((await callWithParams(work, "POST", at(s.app.id, `/${c.id}/work`), { role: "change", employeeId: s.pm.id, note: "tambah filter" }, { id: s.app.id, moduleId: c.id })).json.code).toBe("builder_not_coder");
  });

  it("pausing or dropping a module drops its waiting build and refuses new ones; members cannot build", async () => {
    const s = await setup("ADMIN");
    const [a, b] = [await mod(s, "A", "aa"), await mod(s, "B", "bb")];
    await prd(s, a.id);
    await prd(s, b.id);
    await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: a.id });
    await callWithParams(work, "POST", at(s.app.id, `/${b.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: b.id });
    expect((await callWithParams(patchModule, "PATCH", at(s.app.id, `/${b.id}`), { hold: "dropped" }, { id: s.app.id, moduleId: b.id })).status).toBe(200);
    const [row] = await db.select().from(appModules).where(eq(appModules.id, b.id));
    expect(row).toMatchObject({ hold: "dropped", pendingWork: null });
    expect((await callWithParams(work, "POST", at(s.app.id, `/${b.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: b.id })).json.code).toBe("app_module_on_hold");
    expect((await callWithParams(askPrd, "POST", at(s.app.id, `/${b.id}/prd`), { employeeId: s.pm.id }, { id: s.app.id, moduleId: b.id })).json.code).toBe("app_module_on_hold");
    // the technical name is fixed once something was built
    expect((await callWithParams(patchModule, "PATCH", at(s.app.id, `/${a.id}`), { slug: "baru" }, { id: s.app.id, moduleId: a.id })).json.code).toBe("app_module_slug_fixed");
    // cancelling when nothing waits is harmless
    expect((await callWithParams(unqueue, "DELETE", at(s.app.id, `/${a.id}/work`), undefined, { id: s.app.id, moduleId: a.id })).status).toBe(200);

    const m = await setup("MEMBER");
    const x = await mod(m, "X", "xx");
    await prd(m, x.id);
    expect((await callWithParams(work, "POST", at(m.app.id, `/${x.id}/work`), { role: "build", employeeId: m.dev.id }, { id: m.app.id, moduleId: x.id })).status).toBe(403);
  });

  it("an app without a repository can plan modules but not build them", async () => {
    const s = await setup("ADMIN", { repository: false });
    const a = await mod(s, "A", "aa");
    await prd(s, a.id);
    expect((await callWithParams(work, "POST", at(s.app.id, `/${a.id}/work`), { role: "build", employeeId: s.dev.id }, { id: s.app.id, moduleId: a.id })).json.code).toBe("app_no_repository");
  });

  it("earlier pushed work is registered from the platform's records; status follows the merge and the LIVE release", async () => {
    const s = await setup("ADMIN");
    const a = await mod(s, "Faktur", "faktur");
    await prd(s, a.id);
    const [old] = await db.insert(tasks).values({ workspaceId: s.ws.id, title: "Faktur v0", assigneeId: s.dev.id, status: "DONE", repositoryId: s.repo!.id }).returning();
    const h = head();
    await db.insert(approvals).values({ workspaceId: s.ws.id, taskId: old!.id, employeeId: s.dev.id, toolName: "git_push", title: "push", status: "EXECUTED", payload: { head: h, branch: `agent/${old!.id}` } });

    const c = await callWithParams(candidates, "GET", at(s.app.id, `/${a.id}/register`), undefined, { id: s.app.id, moduleId: a.id });
    expect(c.json.candidates).toEqual([expect.objectContaining({ taskId: old!.id, head: h, state: "unmerged" })]);
    expect((await callWithParams(register, "POST", at(s.app.id, `/${a.id}/register`), { taskId: old!.id }, { id: s.app.id, moduleId: a.id })).json).toMatchObject({ ok: true, state: "unmerged" });
    expect((await callWithParams(register, "POST", at(s.app.id, `/${a.id}/register`), { taskId: old!.id }, { id: s.app.id, moduleId: a.id })).json.code).toBe("app_module_task_linked");
    expect((await views(s))[0]).toMatchObject({ status: "in_review" });

    await db.insert(approvals).values({ workspaceId: s.ws.id, taskId: old!.id, toolName: "merge_branch", title: "merge", status: "EXECUTED", payload: { head: h }, executionResult: { ok: true, details: { commit: h } } });
    expect((await views(s))[0]).toMatchObject({ status: "merged", inLive: false });

    // the worker records which modules a release contains; LIVE running it makes the module live
    const [server] = await db.select().from(servers).where(eq(servers.workspaceId, s.ws.id));
    const [live] = await db
      .insert(appEnvironments)
      .values({ appId: s.app.id, workspaceId: s.ws.id, kind: "live", serverId: server!.id, instanceName: `${s.app.slug}-live`, domain: `${s.app.slug}.example.org`, port: APP_PORT_MIN + 800 + Math.floor(Math.random() * 190) })
      .returning();
    const [rel] = await db.insert(appReleases).values({ appId: s.app.id, workspaceId: s.ws.id, environmentId: live!.id, commit: h, branch: "main", status: "deployed", trigger: "manual", modules: [a.id] }).returning();
    await db.update(appEnvironments).set({ currentReleaseId: rel!.id }).where(eq(appEnvironments.id, live!.id));
    expect((await views(s))[0]).toMatchObject({ status: "live", inLive: true });

    // a task that pushed nothing cannot be registered
    const [none] = await db.insert(tasks).values({ workspaceId: s.ws.id, title: "nothing", assigneeId: s.dev.id, status: "DONE", repositoryId: s.repo!.id }).returning();
    expect((await callWithParams(register, "POST", at(s.app.id, `/${a.id}/register`), { taskId: none!.id }, { id: s.app.id, moduleId: a.id })).json.code).toBe("app_module_no_work");
  });

  it("a PRD deliverable becomes the module's next PRD draft; it waits in Needs a decision under the module", async () => {
    const s = await setup("ADMIN");
    const a = await mod(s, "Faktur", "faktur");
    await prd(s, null);
    const deliverableId = randomUUID();
    const [t] = await db
      .insert(tasks)
      .values({ workspaceId: s.ws.id, title: "PRD dari chat", assigneeId: s.pm.id, status: "DONE", deliverables: [{ id: deliverableId, kind: "prd", title: "PRD Faktur", content: PRD, createdAt: new Date().toISOString() }] })
      .returning();
    const r = await callWithParams(importPrd, "POST", at(s.app.id, `/${a.id}/prd/import`), { taskId: t!.id, deliverableId }, { id: s.app.id, moduleId: a.id });
    expect(r.json).toEqual({ version: 1 });
    const [d] = await db.select().from(appDocuments).where(and(eq(appDocuments.moduleId, a.id), eq(appDocuments.version, 1)));
    expect(d).toMatchObject({ status: "draft", kind: "prd" });
    // the app's own PRD numbering is untouched
    expect(await db.select().from(appDocuments).where(and(eq(appDocuments.appId, s.app.id), isNull(appDocuments.moduleId)))).toHaveLength(1);
    const box = await callWithParams(inbox, "GET", "/api/inbox", undefined, {});
    expect((box.json.items as { kind: string; id: string }[]).find((x) => x.kind === "doc_review" && x.id === d!.id)).toMatchObject({ module: { id: a.id, name: "Faktur" }, app: { name: "ERP" } });
  });
});
