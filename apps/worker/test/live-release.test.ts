import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, approvals, apps, appReleases, audit, db, members, repositories, steps, tasks, users } from "@wfos/db";
import { requestReleasePayloadSchema, type NotifyJob, type ReleaseWindow, type ToolPermission } from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
import { buildTools, type RunContext } from "../src/tools/registry";
import { afterApprovalResolved, afterReleaseSettled, executeApproval, previewOutstanding } from "../src/runner/approvals";
import { runRelease } from "../src/deploy/pipeline";
import { buildSystemPrompt } from "../src/runner/prompt";
import { describeWindow, nextWindowOpening, outsideWindowMessage } from "../src/deploy/window";
import { FakeServer, fastDeploys, makeApp, makeLive, makeRemote, okDns, queueRelease } from "./deploy-fixtures";
import { makeApproval, makeEmployee, makeTask, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

// SSH is never real (FakeServer), public DNS is never asked (checkDomains mocked), the repository is a local git repo.
vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, sshExec: vi.fn(), sftpPut: vi.fn() };
});
vi.mock("@wfos/shared/dns", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/dns")>();
  return { ...real, checkDomains: vi.fn() };
});

let srv: FakeServer;
beforeEach(() => {
  resetTransport();
  srv = new FakeServer();
  srv.install();
  fastDeploys();
  vi.mocked(checkDomains).mockReset();
  vi.mocked(checkDomains).mockImplementation(async (names) => okDns(names));
});

const PERMS: ToolPermission[] = ["git_push", "list_apps", "request_preview", "request_release"].map((tool) => ({ tool, enabled: true }));
const text = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
const envRow = async (id: string) => (await db.select().from(appEnvironments).where(eq(appEnvironments.id, id)))[0]!;
const releaseRow = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!;
const approvalRow = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const approvalsOf = (taskId: string, tool = "request_release") => db.select().from(approvals).where(and(eq(approvals.taskId, taskId), eq(approvals.toolName, tool)));
const liveReleasesOf = (taskId: string, envId: string) => db.select().from(appReleases).where(and(eq(appReleases.taskId, taskId), eq(appReleases.environmentId, envId)));
const runJobs = () => transport.queued.filter((q) => q.queue === "runs").map((q) => q.data as { taskId: string; resumeNote?: string });
const deployJobs = () => transport.queued.filter((q) => q.queue === "deploys");

/** HH:MM (UTC) `min` minutes from now */
const hhmm = (min: number) => new Date(Date.now() + min * 60_000).toISOString().slice(11, 16);
const openWindow = (): ReleaseWindow => ({ days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(-60), end: hhmm(60), timeZone: "UTC" });
const closedWindow = (): ReleaseWindow => ({ days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(120), end: hhmm(180), timeZone: "UTC" });

/**
 * An Owner's app: the preview ran the first commit, LIVE runs it (released by the Owner on the web), then v2 on main
 * was deployed to the preview. A Developer task on the app's repository with request_release granted.
 */
async function setup(o: { live?: Parameters<typeof makeLive>[2]; liveRuns?: boolean; perms?: ToolPermission[] } = {}) {
  const repo = makeRemote();
  const f = await makeApp({ remote: repo.remote, role: "OWNER" });
  const prev1 = await queueRelease(f.app, { createdBy: f.user.id });
  expect(await runRelease(prev1.id, f.ws.id)).toBe("deployed");
  const live = await makeLive(f.app, f.server.id, o.live);
  let live1: Awaited<ReturnType<typeof releaseRow>> | null = null;
  if (o.liveRuns !== false) {
    const l1 = await queueRelease(f.app, { environmentId: live.id, commit: (await releaseRow(prev1.id)).commit, promotedFromReleaseId: prev1.id, createdBy: f.user.id });
    expect(await runRelease(l1.id, f.ws.id)).toBe("deployed");
    live1 = await releaseRow(l1.id);
  }
  const v2 = repo.commit({ "src/notes.tsx": "export const notes = 1;\n", "prisma/migrations/0002_notes/migration.sql": "CREATE TABLE IF NOT EXISTS notes (id int);\n" }, "Notes page");
  const prev2 = await queueRelease(f.app, { createdBy: f.user.id });
  expect(await runRelease(prev2.id, f.ws.id)).toBe("deployed");
  const [admin] = await db.insert(users).values({ email: `adm-${randomUUID().slice(0, 8)}@test.local`, name: "Admin", passwordHash: "x" }).returning();
  await db.insert(members).values({ workspaceId: f.ws.id, userId: admin!.id, role: "ADMIN" });
  const emp = await makeEmployee(f.ws.id, { autonomyLevel: "EXECUTE", toolPermissions: o.perms ?? PERMS });
  const task = await makeTask(f.ws.id, emp.id, { repositoryId: f.repo.id, status: "RUNNING" });
  const repoRef = { id: f.repo.id, name: f.repo.name, provider: "git" as const, url: f.repo.url, defaultBranch: "main", token: null };
  const ctx: RunContext = runContext(f.ws, emp, task.id, { workspace: { egressDomains: [], repository: repoRef } });
  const call = (c: RunContext, name: string, args: Record<string, unknown>) => buildTools(c).find((d) => d.name === name)!.handler(args, {});
  srv.calls.length = 0;
  resetTransport();
  return { ...f, remote: repo, live, live1, v2, prev1: await releaseRow(prev1.id), prev2: await releaseRow(prev2.id), admin: admin!, emp, task, ctx, repoRef, call };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** request_release → its PENDING approval, then decided (APPROVED) by `by` (the Owner by default) */
async function requestAndApprove(s: Setup, o: { by?: string; args?: Record<string, unknown> } = {}) {
  const r = await s.call(s.ctx, "request_release", { appId: s.app.id, summary: "Notes go live", ...o.args });
  expect(r.isError, text(r)).toBeFalsy();
  const [a] = (await approvalsOf(s.task.id)).filter((x) => x.status === "PENDING");
  await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, s.task.id));
  await db.update(approvals).set({ status: "APPROVED", decidedBy: o.by ?? s.user.id, decidedAt: new Date() }).where(eq(approvals.id, a!.id));
  return a!;
}

describe("release windows", () => {
  // 2026-10-14 is a Wednesday; Asia/Jakarta is UTC+7
  const w: ReleaseWindow = { days: [3], start: "22:00", end: "05:00", timeZone: "Asia/Jakarta" };

  it("describes the window and finds its next opening", () => {
    expect(describeWindow(w)).toBe("Wed 22:00–05:00 (to the next day) (Asia/Jakarta)");
    expect(describeWindow({ ...w, days: [0, 1, 2, 3, 4, 5, 6], start: "01:00", end: "03:00" })).toBe("every day 01:00–03:00 (Asia/Jakarta)");
    // Wed 09:00 WIB → Wed 22:00 WIB
    expect(nextWindowOpening(w, new Date("2026-10-14T02:00:00Z"))).toEqual(new Date("2026-10-14T15:00:00Z"));
    // Thu 06:00 WIB (just after it closed) → next Wednesday
    expect(nextWindowOpening(w, new Date("2026-10-14T23:00:00Z"))).toEqual(new Date("2026-10-21T15:00:00Z"));
    // inside: open now
    expect(nextWindowOpening(w, new Date("2026-10-14T16:00:00Z"))).toBeNull();
    // a window at :45 in a zone at +05:45
    const np: ReleaseWindow = { days: [3], start: "10:45", end: "11:00", timeZone: "Asia/Kathmandu" };
    expect(nextWindowOpening(np, new Date("2026-10-14T00:00:00Z"))).toEqual(new Date("2026-10-14T05:00:00Z"));
  });

  it("the refusal names the window and the next opening; none inside it or without one", () => {
    const m = outsideWindowMessage(w, new Date("2026-10-14T02:00:00Z"))!;
    expect(m).toContain("Wed 22:00–05:00 (to the next day) (Asia/Jakarta)");
    expect(m).toContain("opens next Wed 14 Oct 22:00 (Asia/Jakarta)");
    expect(m).toContain("A rollback is always allowed");
    expect(outsideWindowMessage(w, new Date("2026-10-14T16:00:00Z"))).toBeNull();
    expect(outsideWindowMessage(null)).toBeNull();
  });

  it("prepare refuses a LIVE release outside the window (nothing touched); inside it goes; a rollback always goes", async () => {
    const s = await setup();
    await db.update(appEnvironments).set({ releaseWindow: closedWindow() }).where(eq(appEnvironments.id, s.live.id));
    const rel = await queueRelease(s.app, { environmentId: s.live.id, commit: s.prev2.commit, promotedFromReleaseId: s.prev2.id, createdBy: s.user.id });
    expect(await runRelease(rel.id, s.ws.id)).toBe("failed");
    expect(await releaseRow(rel.id)).toMatchObject({ status: "failed", step: "prepare", error: expect.stringMatching(/LIVE releases may only start every day .* \(UTC\).*opens next/) });
    expect(srv.calls).toEqual([]);
    expect(await envRow(s.live.id)).toMatchObject({ status: "running", currentReleaseId: s.live1!.id });

    // a rollback outside the window: allowed (LIVE runs v2 first, released inside the window)
    await db.update(appEnvironments).set({ releaseWindow: openWindow() }).where(eq(appEnvironments.id, s.live.id));
    const v2 = await queueRelease(s.app, { environmentId: s.live.id, commit: s.prev2.commit, promotedFromReleaseId: s.prev2.id, createdBy: s.user.id });
    expect(await runRelease(v2.id, s.ws.id)).toBe("deployed");
    await db.update(appEnvironments).set({ releaseWindow: closedWindow() }).where(eq(appEnvironments.id, s.live.id));
    const rb = await queueRelease(s.app, { environmentId: s.live.id, trigger: "rollback", rollbackOfId: v2.id, commit: s.live1!.commit, branch: "main", manifest: s.live1!.manifest, createdBy: s.user.id });
    expect(await runRelease(rb.id, s.ws.id)).toBe("deployed");
    // previews never have a window
    const p = await queueRelease(s.app, { createdBy: s.user.id });
    await runRelease(p.id, s.ws.id);
    expect((await releaseRow(p.id)).error ?? "").not.toMatch(/window/);
  });
});

describe("request_release (tool)", () => {
  it("is refused outside Workspace mode, for another repository's app, and without a LIVE environment", async () => {
    const s = await setup();
    expect(text(await s.call(runContext(s.ws, s.emp, s.task.id), "request_release", { appId: s.app.id, summary: "x" }))).toMatch(/only in Workspace mode/);
    const [other] = await db.insert(repositories).values({ workspaceId: s.ws.id, name: `other-${randomUUID().slice(0, 6)}`, provider: "git", url: s.repo.url }).returning();
    await db.update(apps).set({ repositoryId: other!.id }).where(eq(apps.id, s.app.id));
    expect(text(await s.call(s.ctx, "request_release", { appId: s.app.id, summary: "x" }))).toMatch(/not linked to your repository/);
    await db.update(apps).set({ repositoryId: s.repo.id }).where(eq(apps.id, s.app.id));
    await db.delete(appEnvironments).where(eq(appEnvironments.id, s.live.id));
    const r = await s.call(s.ctx, "request_release", { appId: s.app.id, summary: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/has no LIVE environment: an Owner sets it up first/);
    expect(await approvalsOf(s.task.id)).toEqual([]);
  });

  it("only a preview release of that app that deployed; not what LIVE already runs", async () => {
    const s = await setup();
    // a LIVE release is not a preview release
    expect(text(await s.call(s.ctx, "request_release", { appId: s.app.id, fromReleaseId: s.live1!.id, summary: "x" }))).toMatch(/is not a release of the preview/);
    // a failed preview release
    const failed = await queueRelease(s.app, { commit: s.v2, status: "failed" });
    expect(text(await s.call(s.ctx, "request_release", { appId: s.app.id, fromReleaseId: failed.id, summary: "x" }))).toMatch(/is failed: only a preview version that deployed can go LIVE/);
    // another app's release
    const foreign = await setup();
    expect(text(await s.call(s.ctx, "request_release", { appId: s.app.id, fromReleaseId: foreign.prev2.id, summary: "x" }))).toMatch(/is not a release of the preview/);
    // the superseded first preview release is the version LIVE runs
    expect(text(await s.call(s.ctx, "request_release", { appId: s.app.id, fromReleaseId: s.prev1.id, summary: "x" }))).toMatch(/LIVE already runs commit/);
    expect(await approvalsOf(s.task.id)).toEqual([]);
  });

  it("payload: the preview's current version, commits and files since LIVE's, warnings, migrations, LIVE env changes, window; an approval even with an allow-list rule", async () => {
    const window = openWindow();
    const s = await setup({ live: { releaseWindow: window } });
    // an Admin changed LIVE variables after the release LIVE runs (names only reach the payload)
    await audit({ workspaceId: s.ws.id, actorLabel: "a@x", action: "app.env_updated", targetType: "app", targetId: s.app.id, details: { environmentId: s.live.id, added: ["NEW_KEY"], changed: ["SMTP_PASSWORD"], removed: [] } });
    await audit({ workspaceId: s.ws.id, actorLabel: "a@x", action: "app.env_updated", targetType: "app", targetId: s.app.id, details: { environmentId: s.preview.id, added: ["PREVIEW_ONLY"] } });
    s.ctx.employee.autonomyLevel = "CLOSE";
    s.ctx.employee.allowList = [{ tool: "request_release", recipientDomains: [], clientIds: [] }];
    const r = await s.call(s.ctx, "request_release", { appId: s.app.id, summary: "Notes go live" });
    expect(text(r)).toMatch(/Queued for human approval/);
    expect(text(r)).toMatch(/an Owner of the workspace must approve it/);
    const [a] = await approvalsOf(s.task.id);
    expect(a!.status).toBe("PENDING");
    const p = requestReleasePayloadSchema.parse(a!.payload);
    expect(p).toMatchObject({
      appId: s.app.id,
      appName: s.app.name,
      environmentId: s.live.id,
      url: `https://${s.live.domain}`,
      fromReleaseId: s.prev2.id,
      commit: s.v2,
      commitSubject: "Notes page",
      currentCommit: s.live1!.commit,
      commits: [{ sha: s.v2, subject: "Notes page" }],
      filesTruncated: false,
      migrations: "breaking",
      database: true,
      liveEnvChanged: ["NEW_KEY", "SMTP_PASSWORD"],
      releaseWindow: window,
      summary: "Notes go live",
    });
    expect(p.files.map((f) => f.path).sort()).toEqual(["prisma/migrations/0002_notes/migration.sql", "src/notes.tsx"]);
    expect(p.warnings).toEqual(["public_access"]);
    expect(deployJobs()).toEqual([]);
    expect(a!.title).toBe(`Release ${s.app.name} to LIVE: ${s.v2.slice(0, 8)}`);
  });

  it("dry run: simulated, no approval, no release", async () => {
    const s = await setup();
    const dry = { ...s.ctx, dryRun: true };
    expect(text(await s.call(dry, "request_release", { appId: s.app.id, summary: "x" }))).toMatch(/^DRY RUN: request_release was NOT executed/);
    expect(dry.deliverables.map((d) => d.kind)).toEqual(["simulated_action"]);
    expect(await approvalsOf(s.task.id)).toEqual([]);
    expect(await liveReleasesOf(s.task.id, s.live.id)).toEqual([]);
  });

  it("list_apps shows the preview release id request_release names, and the LIVE window", async () => {
    const window = openWindow();
    const s = await setup({ live: { releaseWindow: window } });
    const out = JSON.parse(text(await s.call(s.ctx, "list_apps", {}))) as { apps: { currentRelease: { id: string }; live: { releaseWindow: unknown } }[] };
    expect(out.apps[0]!.currentRelease.id).toBe(s.prev2.id);
    expect(out.apps[0]!.live.releaseWindow).toEqual(window);
  });
});

describe("request_release (approved)", () => {
  it("decided by an Admin (not an Owner): fails, nothing queued, back to the Developer", async () => {
    const s = await setup();
    const a = await requestAndApprove(s, { by: s.admin.id });
    await executeApproval(a.id);
    const after = await approvalRow(a.id);
    expect(after.status).toBe("FAILED");
    expect((after.executionResult as { summary: string }).summary).toMatch(/Only an Owner of the workspace can approve a LIVE release/);
    expect(await liveReleasesOf(s.task.id, s.live.id)).toEqual([]);
    expect(deployJobs()).toEqual([]);
    expect((await taskRow(s.task.id)).status).toBe("QUEUED");
    expect(runJobs()[0]!.resumeNote).toMatch(/Releasing to LIVE FAILED before anything was released .*Only an Owner.*Failed LIVE releases of this task so far: 1 of 3/);
  });

  it("an edited request is never released", async () => {
    const s = await setup();
    const a = await requestAndApprove(s);
    await db.update(approvals).set({ editedPayload: { ...a.payload, summary: "edited" } }).where(eq(approvals.id, a.id));
    await executeApproval(a.id);
    expect((await approvalRow(a.id)).status).toBe("FAILED");
    expect(((await approvalRow(a.id)).executionResult as { summary: string }).summary).toMatch(/cannot be edited/);
    expect(await liveReleasesOf(s.task.id, s.live.id)).toEqual([]);
  });

  it("refused when the preview release no longer qualifies, LIVE is busy, or the window is closed", async () => {
    const s = await setup();
    const a = await requestAndApprove(s);
    await db.update(appReleases).set({ status: "failed" }).where(eq(appReleases.id, s.prev2.id));
    await executeApproval(a.id);
    expect(((await approvalRow(a.id)).executionResult as { summary: string }).summary).toMatch(/no longer a deployed version of the preview: nothing was released/);
    await db.update(appReleases).set({ status: "deployed" }).where(eq(appReleases.id, s.prev2.id));

    const t = await setup();
    await queueRelease(t.app, { environmentId: t.live.id, commit: t.prev2.commit, status: "deploying", createdBy: t.user.id });
    const b = await requestAndApprove(t);
    await executeApproval(b.id);
    expect(((await approvalRow(b.id)).executionResult as { summary: string }).summary).toMatch(/\(LIVE\) already has a release deploying/);

    const u = await setup();
    const c = await requestAndApprove(u);
    await db.update(appEnvironments).set({ releaseWindow: closedWindow() }).where(eq(appEnvironments.id, u.live.id));
    await executeApproval(c.id);
    expect(((await approvalRow(c.id)).executionResult as { summary: string }).summary).toMatch(/The LIVE release was not queued \(the release window is closed\): LIVE releases may only start .*opens next/);
    expect(await liveReleasesOf(u.task.id, u.live.id)).toEqual([]);
    expect(deployJobs()).toEqual([]);
    // a closed window is not a failed attempt
    expect(runJobs().find((j) => j.taskId === u.task.id)!.resumeNote).toMatch(/opens next[\s\S]*Failed LIVE releases of this task so far: 0 of 3/);
  });

  it("refused when LIVE changed since the request, or the request is older than 24 h (not counted)", async () => {
    const s = await setup();
    const a = await requestAndApprove(s);
    // the Owner released v2 from the web meanwhile
    const [now] = await db.insert(appReleases).values({ appId: s.app.id, environmentId: s.live.id, workspaceId: s.ws.id, commit: s.v2, branch: "main", trigger: "manual", status: "deployed" }).returning();
    await db.update(appEnvironments).set({ currentReleaseId: now!.id }).where(eq(appEnvironments.id, s.live.id));
    await executeApproval(a.id);
    const r1 = await approvalRow(a.id);
    expect(r1.status).toBe("FAILED");
    expect((r1.executionResult as { summary: string }).summary).toMatch(new RegExp(`LIVE changed since this request \\(now ${s.v2.slice(0, 7)}\\): ask|LIVE changed since this request \\(now ${s.v2.slice(0, 7)}\\)`));
    expect(await liveReleasesOf(s.task.id, s.live.id)).toEqual([]);
    expect(runJobs()[0]!.resumeNote).toContain("Failed LIVE releases of this task so far: 0 of 3");

    const t = await setup();
    const b = await requestAndApprove(t);
    await db.update(approvals).set({ createdAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(approvals.id, b.id));
    await executeApproval(b.id);
    expect(((await approvalRow(b.id)).executionResult as { summary: string }).summary).toMatch(/older than 24 hours: nothing was released/);
    expect(await liveReleasesOf(t.task.id, t.live.id)).toEqual([]);
  });

  it("a window that closed before the deploy started: refused in prepare, not counted, the note says when it opens", async () => {
    const s = await setup();
    const a = await requestAndApprove(s);
    await executeApproval(a.id);
    const [rel] = await liveReleasesOf(s.task.id, s.live.id);
    await db.update(appEnvironments).set({ releaseWindow: closedWindow() }).where(eq(appEnvironments.id, s.live.id));
    expect(await runRelease(rel!.id, s.ws.id)).toBe("failed");
    expect(await releaseRow(rel!.id)).toMatchObject({ step: "prepare", checkpoint: expect.objectContaining({ refusal: "release_window" }) });
    expect(srv.calls).toEqual([]);
    const note = runJobs()[0]!.resumeNote!;
    expect(note).toMatch(/opens next/);
    expect(note).toContain("Failed LIVE releases of this task so far: 0 of 3");
  });

  it("an Owner's approval queues the LIVE release; the task waits, then gets the LIVE URL and finishes", async () => {
    const s = await setup();
    const a = await requestAndApprove(s);
    await executeApproval(a.id);
    const after = await approvalRow(a.id);
    expect(after.status).toBe("EXECUTED");
    const [rel] = await liveReleasesOf(s.task.id, s.live.id);
    expect(rel).toMatchObject({
      environmentId: s.live.id,
      commit: s.v2,
      status: "queued",
      trigger: "approval",
      approvalId: a.id,
      taskId: s.task.id,
      promotedFromReleaseId: s.prev2.id,
      createdBy: s.user.id,
    });
    expect((after.executionResult as { summary: string }).summary).toBe(`LIVE release queued: release ${rel!.id}`);
    expect(deployJobs()).toEqual([{ queue: "deploys", name: "release", data: { kind: "release", releaseId: rel!.id, workspaceId: s.ws.id }, opts: expect.anything() }]);
    expect((await taskRow(s.task.id)).status).toBe("AWAITING_APPROVAL");
    const waits = await db.select().from(steps).where(and(eq(steps.taskId, s.task.id), eq(steps.name, "waiting_for_live")));
    expect(waits.map((w) => w.output)).toEqual([expect.objectContaining({ releaseId: rel!.id })]);
    expect(await previewOutstanding(s.task.id)).toBe(true);

    // the pipeline accepts it (an Owner decided the approval) and releases it blue-green
    expect(await runRelease(rel!.id, s.ws.id)).toBe("deployed");
    expect(await envRow(s.live.id)).toMatchObject({ status: "running", currentReleaseId: rel!.id });
    const t = await taskRow(s.task.id);
    expect(t.status).toBe("DONE");
    const url = `https://${s.live.domain}`;
    expect(t.deliverables.filter((d) => d.title === `LIVE: ${url}`)).toEqual([expect.objectContaining({ kind: "summary", meta: expect.objectContaining({ releaseId: rel!.id, url, environment: "live" }) })]);
    expect(t.result).toContain(`deployed at ${url}`);
    expect((await approvalRow(a.id)).executionResult).toMatchObject({ details: { release: { id: rel!.id, status: "deployed", url } } });
    expect(await db.select().from(steps).where(and(eq(steps.taskId, s.task.id), eq(steps.name, "live_deployed")))).toHaveLength(1);
    // the approving Owner hears that LIVE changed (besides the task's own notification)
    const notes = transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob);
    expect(notes).toContainEqual(expect.objectContaining({ userId: s.user.id, link: `/apps/${s.app.id}`, subject: `LIVE updated: ${s.app.name} (LIVE)` }));
    expect(notes.filter((n) => n.link === `/tasks/${s.task.id}`)).toHaveLength(1);
  });

  it("a failed LIVE release goes back to the Developer with the log tail; it counts apart from previews", async () => {
    const s = await setup();
    // two failed previews of this task earlier (handed back already)
    for (let i = 0; i < 2; i++) {
      const old = await makeApproval(s.ws.id, s.task.id, s.emp.id, { toolName: "request_preview", status: "EXECUTED", payload: { appName: s.app.name, commit: s.v2 }, executionResult: { ok: true, summary: "Preview queued", consumed: true } });
      await db.insert(appReleases).values({ appId: s.app.id, environmentId: s.preview.id, workspaceId: s.ws.id, commit: s.v2, branch: "main", trigger: "approval", status: "failed", approvalId: old.id, taskId: s.task.id });
    }
    srv.replies["build-run:build"] = { code: 1, data: "Type error: boom\n" };
    const a = await requestAndApprove(s);
    await executeApproval(a.id);
    const [rel] = await liveReleasesOf(s.task.id, s.live.id);
    expect(await runRelease(rel!.id, s.ws.id)).toBe("failed");
    // the old version keeps serving LIVE
    expect(await envRow(s.live.id)).toMatchObject({ status: "running", currentReleaseId: s.live1!.id });
    expect((await taskRow(s.task.id)).status).toBe("QUEUED");
    const note = runJobs()[0]!.resumeNote!;
    expect(note).toContain(`The LIVE release of ${s.app.name} (commit ${s.v2.slice(0, 8)}), release ${rel!.id}, FAILED (LIVE was not updated) at step build`);
    expect(note).toContain("Type error: boom");
    expect(note).toMatch(/call request_release again only if the task still asks for LIVE/);
    expect(note).toContain("Failed LIVE releases of this task so far: 1 of 3");
  });
});

describe("prepare: LIVE releases from tasks", () => {
  /** a LIVE release as the executor would queue it, from an approval shaped by `over` */
  async function forged(s: Setup, over: Partial<typeof approvals.$inferInsert>, rel: Partial<typeof appReleases.$inferInsert> = {}) {
    const r = await s.call(s.ctx, "request_release", { appId: s.app.id, summary: "x" });
    expect(r.isError, text(r)).toBeFalsy();
    const [a] = await approvalsOf(s.task.id);
    await db.update(approvals).set({ status: "EXECUTED", decidedBy: s.user.id, ...over }).where(eq(approvals.id, a!.id));
    return queueRelease(s.app, { environmentId: s.live.id, commit: s.v2, promotedFromReleaseId: s.prev2.id, trigger: "approval", approvalId: a!.id, taskId: s.task.id, createdBy: s.user.id, ...rel });
  }

  it.each([
    ["decided by an Admin", (s: Setup) => ({ over: { decidedBy: s.admin.id } })],
    ["not executed", () => ({ over: { status: "PENDING" as const } })],
    ["of another tool", () => ({ over: { toolName: "request_preview" } })],
    ["edited", (s: Setup) => ({ over: { editedPayload: { appId: s.app.id } } })],
    ["naming another commit", (s: Setup) => ({ over: {}, rel: { commit: s.prev1.commit, promotedFromReleaseId: s.prev1.id } })],
    ["of another task", () => ({ over: {}, rel: { taskId: null } })],
  ] as const)("refuses one whose approval is %s", async (_n, make) => {
    const s = await setup();
    const m = make(s) as { over: Partial<typeof approvals.$inferInsert>; rel?: Partial<typeof appReleases.$inferInsert> };
    const rel = await forged(s, m.over, m.rel ?? {});
    expect(await runRelease(rel.id, s.ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/A task cannot release to LIVE/);
    expect(srv.calls).toEqual([]);
    expect(await envRow(s.live.id)).toMatchObject({ currentReleaseId: s.live1!.id });
  });

  it("a task release with no approval at all is refused as before", async () => {
    const s = await setup();
    const rel = await queueRelease(s.app, { environmentId: s.live.id, commit: s.v2, promotedFromReleaseId: s.prev2.id, taskId: s.task.id, createdBy: s.user.id });
    expect(await runRelease(rel.id, s.ws.id)).toBe("failed");
    expect((await releaseRow(rel.id)).error).toMatch(/A task cannot release to LIVE/);
  });
});

describe("after a preview deploys", () => {
  /** an executed request_preview of v2 whose preview release just deployed */
  async function previewDeployedByTask(s: Setup, o: { title?: string; commit?: string } = {}) {
    await db.update(tasks).set({ status: "AWAITING_APPROVAL", title: o.title ?? "Add a notes page and release it to LIVE" }).where(eq(tasks.id, s.task.id));
    const commit = o.commit ?? s.v2;
    const a = await makeApproval(s.ws.id, s.task.id, s.emp.id, { toolName: "request_preview", status: "EXECUTED", payload: { appName: s.app.name, commit }, executionResult: { ok: true, summary: "Preview queued: release x" } });
    const [rel] = await db
      .insert(appReleases)
      .values({ appId: s.app.id, environmentId: s.preview.id, workspaceId: s.ws.id, commit, branch: `agent/${s.task.id}`, trigger: "approval", status: "deployed", approvalId: a.id, taskId: s.task.id, finishedAt: new Date() })
      .returning();
    return { approval: a, release: rel! };
  }

  it("the Developer gets it back once to propose LIVE when the task asks for it (request_release granted, the app has LIVE)", async () => {
    const s = await setup();
    const { approval, release } = await previewDeployedByTask(s);
    expect(await previewOutstanding(s.task.id)).toBe(true);
    await afterReleaseSettled(release.id);
    expect((await taskRow(s.task.id)).status).toBe("QUEUED");
    const note = runJobs()[0]!.resumeNote!;
    expect(note).toContain(`The preview of "${s.app.name}" is deployed at https://${s.preview.domain}`);
    expect(note).toContain(`Only if this task asks for a LIVE release: call request_release { appId: "${s.app.id}", fromReleaseId: "${release.id}", summary }`);
    expect(note).toMatch(/Never propose a LIVE release the task did not ask for/);
    expect((await approvalRow(approval.id)).executionResult).toMatchObject({ consumed: true, details: { release: { id: release.id, status: "deployed" } } });
    expect((await approvalRow(approval.id)).executionResult).toMatchObject({ offeredRelease: true });
    // once per task: the next resolution finishes, and so does a later preview of the same task
    await db.update(tasks).set({ status: "AWAITING_APPROVAL" }).where(eq(tasks.id, s.task.id));
    await afterApprovalResolved(s.task.id);
    expect((await taskRow(s.task.id)).status).toBe("DONE");
    await db.update(tasks).set({ status: "RUNNING" }).where(eq(tasks.id, s.task.id));
    const later = await previewDeployedByTask(s, { commit: s.prev1.commit });
    await afterReleaseSettled(later.release.id);
    expect((await taskRow(s.task.id)).status).toBe("DONE");
    expect(runJobs()).toHaveLength(1);
  });

  it("no offer when the task does not ask for LIVE (title/brief), in English or Indonesian", async () => {
    const s = await setup();
    const { release } = await previewDeployedByTask(s, { title: "Add a notes page" });
    await afterReleaseSettled(release.id);
    expect((await taskRow(s.task.id)).status).toBe("DONE");
    expect(runJobs()).toEqual([]);
    const { asksForLive } = await import("../src/runner/approvals");
    for (const t of ["Rilis ke LIVE", "deploy ke klien besok", "Go-live checklist", "push to production", "naikkan ke produksi"]) expect(asksForLive({ title: t, brief: "" }), t).toBe(true);
    for (const t of ["Deliver the report", "Fix the product list", "Olive oil page"]) expect(asksForLive({ title: t, brief: "" }), t).toBe(false);
  });

  it("no offer without request_release, or for an app without LIVE", async () => {
    const s = await setup({ perms: PERMS.filter((p) => p.tool !== "request_release") });
    const { release } = await previewDeployedByTask(s);
    await afterReleaseSettled(release.id);
    expect((await taskRow(s.task.id)).status).toBe("DONE");
    const t = await setup();
    await db.delete(appEnvironments).where(eq(appEnvironments.id, t.live.id));
    const d = await previewDeployedByTask(t);
    await afterReleaseSettled(d.release.id);
    expect((await taskRow(t.task.id)).status).toBe("DONE");
    expect(runJobs()).toEqual([]);
  });
});

describe("prompt", () => {
  const base = {
    employee: { id: "e", name: "Dewi", role: "Developer", persona: "", instructions: "", businessContext: "", autonomyLevel: "QUEUE" as const },
    workspaceName: "WS",
    directory: "",
    dryRun: false,
    mode: "task" as const,
    workspace: { egressDomains: [], hasRepository: true },
  };
  it("adds the LIVE rules only with request_release granted", () => {
    const p = buildSystemPrompt({ ...base, grantedTools: ["git_push", "list_apps", "request_preview", "request_release"] });
    expect(p).toContain("## LIVE releases");
    expect(p).toMatch(/Never propose a LIVE release unless the task explicitly asks for one/);
    expect(p).toMatch(/only an Owner of the workspace can approve a LIVE release/);
    expect(p).toMatch(/After request_release, stop/);
    expect(buildSystemPrompt({ ...base, grantedTools: ["git_push", "list_apps", "request_preview"] })).not.toContain("## LIVE releases");
    expect(buildSystemPrompt({ ...base, workspace: undefined, grantedTools: ["request_release"] })).not.toContain("## LIVE releases");
  });
});
