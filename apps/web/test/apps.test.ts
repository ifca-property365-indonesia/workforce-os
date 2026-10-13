import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appReleases, apps, auditLog, clients, db, members, projects, repositories, servers, users, workspaces } from "@wfos/db";
import { APP_PORT_MAX, APP_PORT_MIN, WFOS_HELPER_VERSION, type ServerInfo } from "@wfos/shared";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup2fa } from "@/app/api/me/2fa/setup/route";
import { POST as enable2fa } from "@/app/api/me/2fa/enable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { GET as listApps, POST as createApp } from "@/app/api/apps/route";
import { DELETE as deleteApp, GET as getApp, PATCH as patchApp } from "@/app/api/apps/[id]/route";
import { PUT as putEnv } from "@/app/api/apps/[id]/env/route";
import { GET as viewAccess, POST as rotateAccess } from "@/app/api/apps/[id]/access/route";
import { POST as deployApp } from "@/app/api/apps/[id]/deploy/route";
import { POST as rollbackApp } from "@/app/api/apps/[id]/rollback/route";
import { POST as stopApp } from "@/app/api/apps/[id]/stop/route";
import { POST as startApp } from "@/app/api/apps/[id]/start/route";
import { POST as stopAll } from "@/app/api/apps/stop-all/route";
import { GET as getRelease } from "@/app/api/releases/[id]/route";
import { DELETE as deleteServer, PATCH as patchServer } from "@/app/api/servers/[id]/route";
import { call, callWithParams, jar, queueModule, resetBrowser } from "./browser";

const PASSWORD = "pw-123456-apps";
const SECRET_VALUE = "smtp-pass-Zq9!very-secret";
const INFO: ServerInfo = {
  helperVersion: WFOS_HELPER_VERSION,
  os: "Ubuntu 24.04",
  node: "v24.3.0",
  pnpm: "10.12.1",
  nginx: true,
  certbot: true,
  postgresPort: 5433,
  diskFreeMb: 40_000,
  memTotalMb: 7618,
  memAvailableMb: 4000,
  baseDomain: "preview.example.com",
  systemd: 259,
  firewall: true,
  appsRoot: "/srv/wfos-apps",
};
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const deploy = vi.mocked(queueModule.q.deploy);

beforeEach(() => {
  resetBrowser();
  deploy.mockReset();
  vi.mocked(queueModule.publish).mockClear();
});

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  return ws!;
}

async function signIn(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", wsId?: string) {
  const id = wsId ?? (await workspace()).id;
  const email = `a-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: `${role} person`, passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: id, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  return { email, userId: u!.id, wsId: id };
}

/** someone with 2FA, signed in, who can confirm with password + code (step-up valid 10 minutes) */
async function withTwoFactor(role: "OWNER" | "ADMIN", wsId?: string) {
  const o = await signIn(role, wsId);
  const s = await call(setup2fa, "POST", "/api/me/2fa/setup");
  const secret = String(s.json.secret);
  expect((await call(enable2fa, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
  jar.clear();
  await call(login, "POST", "/api/auth/login", { email: o.email, password: PASSWORD });
  await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
  const stepUp = async () => expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  return { ...o, stepUp };
}

async function addServer(wsId: string, over: Partial<typeof servers.$inferInsert> = {}) {
  const base = `p${randomUUID().slice(0, 6)}.example.com`;
  const [s] = await db
    .insert(servers)
    .values({ workspaceId: wsId, name: `srv-${base}`, host: "45.77.10.20", port: 22, baseDomain: base, status: "ready", info: { ...INFO, baseDomain: base }, ...over })
    .returning();
  return s!;
}

async function addRepo(wsId: string, defaultBranch = "main") {
  const [r] = await db.insert(repositories).values({ workspaceId: wsId, name: `repo-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/shop.git", defaultBranch }).returning();
  return r!;
}

/** a ready server and a repository in the workspace, plus a helper to insert apps straight into the table */
async function fixture(wsId: string) {
  const server = await addServer(wsId);
  const repo = await addRepo(wsId, "develop");
  let n = 0;
  const insertApp = async (over: Partial<typeof apps.$inferInsert> = {}) => {
    n += 1;
    const slug = over.slug ?? `app${n}-${randomUUID().slice(0, 4)}`;
    const [a] = await db
      .insert(apps)
      .values({ workspaceId: wsId, serverId: server.id, repositoryId: repo.id, name: `App ${slug}`, slug, domain: `${slug}.${server.baseDomain}`, port: APP_PORT_MIN + 200 + n, ...over })
      .returning();
    return a!;
  };
  return { server, repo, insertApp };
}

async function addRelease(appId: string, wsId: string, over: Partial<typeof appReleases.$inferInsert> = {}) {
  const [r] = await db
    .insert(appReleases)
    .values({ appId, workspaceId: wsId, commit: SHA, branch: "main", status: "deployed", trigger: "manual", log: "== build ==\nok\n", ...over })
    .returning();
  return r!;
}

const appRow = async (id: string) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
const auditOf = (id: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, action)));
const p = (id: string) => ({ id });

describe("apps: create, list, edit", () => {
  it("an Admin creates an app on a ready server: domain from the slug, branch from the repository, lowest port", async () => {
    const o = await signIn("ADMIN");
    const { server, repo } = await fixture(o.wsId);
    const [c] = await db.insert(clients).values({ workspaceId: o.wsId, name: "Acme" }).returning();
    const [proj] = await db.insert(projects).values({ workspaceId: o.wsId, clientId: c!.id, name: "Shop" }).returning();
    const r = await call(createApp, "POST", "/api/apps", { name: "Shop preview", slug: "shop", serverId: server.id, repositoryId: repo.id, projectId: proj!.id });
    expect(r.status).toBe(200);
    const a = r.json.app as Record<string, unknown>;
    expect(a).toMatchObject({
      name: "Shop preview",
      slug: "shop",
      url: `https://shop.${server.baseDomain}`,
      branch: "develop",
      port: APP_PORT_MIN,
      status: "new",
      accessMode: "password",
      clientId: c!.id,
      projectId: proj!.id,
      serverName: server.name,
      repositoryName: repo.name,
      envKeys: [],
      hasDatabase: false,
      memoryMb: 512,
      currentRelease: null,
    });
    expect(await auditOf(String(a.id), "app.created")).toHaveLength(1);
    expect(queueModule.publish).toHaveBeenCalledWith(o.wsId, { type: "app.updated", appId: a.id, status: "new" });
    // nothing runs until a deploy
    expect(deploy).not.toHaveBeenCalled();

    const list = await call(listApps, "GET", "/api/apps");
    expect((list.json.apps as { id: string }[]).map((x) => x.id)).toEqual([a.id]);
  });

  it("refuses reserved and taken slugs, a taken name, a server that is not ready and links of other workspaces", async () => {
    const o = await signIn("ADMIN");
    const { server, repo, insertApp } = await fixture(o.wsId);
    const base = { name: "X", serverId: server.id, repositoryId: repo.id };
    for (const slug of ["www", "api", "admin", "-x", "a--b", "UPPER", "x"]) {
      const r = await call(createApp, "POST", "/api/apps", { ...base, slug });
      expect(r.status, slug).toBe(400);
    }
    await insertApp({ slug: "taken", name: "Taken" });
    const slugTaken = await call(createApp, "POST", "/api/apps", { ...base, slug: "taken" });
    expect(slugTaken.status).toBe(409);
    expect(slugTaken.json.code).toBe("app_slug_taken");
    const nameTaken = await call(createApp, "POST", "/api/apps", { ...base, name: "Taken", slug: "fresh" });
    expect(nameTaken.status).toBe(409);
    expect(nameTaken.json.code).toBe("app_name_taken");

    const pending = await addServer(o.wsId, { status: "pending" });
    const notReady = await call(createApp, "POST", "/api/apps", { ...base, slug: "fresh", serverId: pending.id });
    expect(notReady.status).toBe(409);
    expect(notReady.json.code).toBe("server_not_ready");

    const other = await workspace();
    const theirServer = await addServer(other.id);
    const theirRepo = await addRepo(other.id);
    const [theirClient] = await db.insert(clients).values({ workspaceId: other.id, name: "Theirs" }).returning();
    expect((await call(createApp, "POST", "/api/apps", { ...base, slug: "fresh", serverId: theirServer.id })).json.code).toBe("server_not_found");
    expect((await call(createApp, "POST", "/api/apps", { ...base, slug: "fresh", repositoryId: theirRepo.id })).json.code).toBe("unknown_repository");
    expect((await call(createApp, "POST", "/api/apps", { ...base, slug: "fresh", clientId: theirClient!.id })).json.code).toBe("unknown_client");
  });

  it("hands out the lowest free port of the server, and 409 when the range is full", async () => {
    const o = await signIn("ADMIN");
    const { server, repo, insertApp } = await fixture(o.wsId);
    await insertApp({ port: APP_PORT_MIN });
    await insertApp({ port: APP_PORT_MIN + 2 });
    const r1 = await call(createApp, "POST", "/api/apps", { name: "One", slug: "one", serverId: server.id, repositoryId: repo.id });
    expect((r1.json.app as { port: number }).port).toBe(APP_PORT_MIN + 1);
    const r2 = await call(createApp, "POST", "/api/apps", { name: "Two", slug: "two", serverId: server.id, repositoryId: repo.id });
    expect((r2.json.app as { port: number }).port).toBe(APP_PORT_MIN + 3);
    // another server's ports are its own
    const s2 = await addServer(o.wsId);
    const r3 = await call(createApp, "POST", "/api/apps", { name: "Three", slug: "three", serverId: s2.id, repositoryId: repo.id });
    expect((r3.json.app as { port: number }).port).toBe(APP_PORT_MIN);

    // fill every port of a third server
    const full = await addServer(o.wsId);
    const rows = [];
    for (let port = APP_PORT_MIN; port <= APP_PORT_MAX; port++) {
      rows.push({ workspaceId: o.wsId, serverId: full.id, repositoryId: repo.id, name: `f${port}`, slug: `f${port}`, domain: `f${port}.${full.baseDomain}`, port });
    }
    await db.insert(apps).values(rows);
    const r4 = await call(createApp, "POST", "/api/apps", { name: "Four", slug: "four", serverId: full.id, repositoryId: repo.id });
    expect(r4.status).toBe(409);
    expect(r4.json.code).toBe("server_ports_full");
  });

  it("edits name, branch, access mode and links; changes are audited", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    await insertApp({ name: "Other" });
    const [c] = await db.insert(clients).values({ workspaceId: o.wsId, name: "Acme" }).returning();
    const r = await callWithParams(patchApp, "PATCH", "/x", { name: "Renamed", branch: "feature/x", accessMode: "public", clientId: c!.id }, p(a.id));
    expect(r.status).toBe(200);
    expect(r.json.app).toMatchObject({ name: "Renamed", branch: "feature/x", accessMode: "public", clientId: c!.id, projectId: null });
    const [audit] = await auditOf(a.id, "app.updated");
    expect(audit!.details).toMatchObject({ changes: { name: "Renamed", branch: "feature/x", accessMode: "public", clientId: c!.id } });
    const dup = await callWithParams(patchApp, "PATCH", "/x", { name: "Other" }, p(a.id));
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe("app_name_taken");
    // slug, server and repository are fixed
    const fixed = await callWithParams(patchApp, "PATCH", "/x", { slug: "moved" }, p(a.id));
    expect(fixed.status).toBe(200);
    expect((await appRow(a.id))!.slug).toBe(a.slug);
  });
});

describe("apps: roles and workspace isolation", () => {
  it("Viewers and Members only read; Admins change apps; only the Owner stops all", async () => {
    const ws = await workspace();
    const { server, repo, insertApp } = await fixture(ws.id);
    const a = await insertApp({ status: "running" });
    const rel = await addRelease(a.id, ws.id);
    await db.update(apps).set({ currentReleaseId: rel.id }).where(eq(apps.id, a.id));
    for (const role of ["VIEWER", "MEMBER"] as const) {
      await signIn(role, ws.id);
      expect((await call(listApps, "GET", "/api/apps")).status).toBe(200);
      expect((await callWithParams(getApp, "GET", "/x", undefined, p(a.id))).status).toBe(200);
      for (const r of [
        await call(createApp, "POST", "/api/apps", { name: "N", slug: "nn", serverId: server.id, repositoryId: repo.id }),
        await callWithParams(patchApp, "PATCH", "/x", { name: "x" }, p(a.id)),
        await callWithParams(putEnv, "PUT", "/x", { A: "b" }, p(a.id)),
        await callWithParams(viewAccess, "GET", "/x", undefined, p(a.id)),
        await callWithParams(rotateAccess, "POST", "/x", {}, p(a.id)),
        await callWithParams(deployApp, "POST", "/x", {}, p(a.id)),
        await callWithParams(rollbackApp, "POST", "/x", { releaseId: rel.id }, p(a.id)),
        await callWithParams(stopApp, "POST", "/x", {}, p(a.id)),
        await callWithParams(startApp, "POST", "/x", {}, p(a.id)),
        await callWithParams(deleteApp, "DELETE", "/x", undefined, p(a.id)),
        await call(stopAll, "POST", "/api/apps/stop-all"),
      ]) {
        expect(r.status).toBe(403);
        expect(r.json.code).toBe("role_required");
      }
    }
    // logs: Members yes, Viewers no
    await signIn("VIEWER", ws.id);
    expect((await callWithParams(getRelease, "GET", "/x", undefined, p(rel.id))).status).toBe(403);
    await signIn("MEMBER", ws.id);
    const member = await callWithParams(getRelease, "GET", "/x", undefined, p(rel.id));
    expect(member.status).toBe(200);
    expect(member.json.log).toBe("== build ==\nok\n");
    expect(member.json.release).toMatchObject({ id: rel.id, status: "deployed", commit: SHA });

    await signIn("ADMIN", ws.id);
    const admin = await call(stopAll, "POST", "/api/apps/stop-all");
    expect(admin.status).toBe(403);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("another workspace's apps and releases are not found anywhere", async () => {
    const other = await workspace();
    const { insertApp } = await fixture(other.id);
    const theirs = await insertApp({ status: "running" });
    const rel = await addRelease(theirs.id, other.id);
    const o = await withTwoFactor("OWNER");
    await o.stepUp();
    for (const r of [
      await callWithParams(getApp, "GET", "/x", undefined, p(theirs.id)),
      await callWithParams(patchApp, "PATCH", "/x", { name: "mine now" }, p(theirs.id)),
      await callWithParams(putEnv, "PUT", "/x", { A: "b" }, p(theirs.id)),
      await callWithParams(viewAccess, "GET", "/x", undefined, p(theirs.id)),
      await callWithParams(deployApp, "POST", "/x", {}, p(theirs.id)),
      await callWithParams(rollbackApp, "POST", "/x", { releaseId: rel.id }, p(theirs.id)),
      await callWithParams(stopApp, "POST", "/x", {}, p(theirs.id)),
      await callWithParams(startApp, "POST", "/x", {}, p(theirs.id)),
      await callWithParams(deleteApp, "DELETE", "/x", undefined, p(theirs.id)),
      await callWithParams(getApp, "GET", "/x", undefined, p("not-a-uuid")),
    ]) {
      expect(r.status).toBe(404);
      expect(r.json.code).toBe("app_not_found");
    }
    const relR = await callWithParams(getRelease, "GET", "/x", undefined, p(rel.id));
    expect(relR.status).toBe(404);
    expect(relR.json.code).toBe("release_not_found");
    expect((await call(listApps, "GET", "/api/apps")).json.apps).toEqual([]);
    // stop-all only touches this workspace
    expect((await call(stopAll, "POST", "/api/apps/stop-all")).json.count).toBe(0);
    expect(deploy).not.toHaveBeenCalled();
    expect(await appRow(theirs.id)).toMatchObject({ name: theirs.name, status: "running" });
  });
});

describe("apps: env and access password stay secret", () => {
  it("env values are write-only: stored encrypted, merged, and only names come back", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const r = await callWithParams(putEnv, "PUT", "/x", { SMTP_PASS: SECRET_VALUE, SMTP_HOST: "mail.example.com" }, p(a.id));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ envKeys: ["SMTP_HOST", "SMTP_PASS"] });
    const row = (await appRow(a.id))!;
    expect(row.envEnc).toMatch(/^v1:/);
    expect(row.envEnc).not.toContain(SECRET_VALUE);

    // merge: a new name and a removal keep the untouched value
    const m = await callWithParams(putEnv, "PUT", "/x", { set: { FEATURE_FLAG: "on" }, remove: ["SMTP_HOST"] }, p(a.id));
    expect(m.json).toEqual({ envKeys: ["FEATURE_FLAG", "SMTP_PASS"] });
    const { readEnv } = await import("@/lib/server/apps");
    expect(readEnv((await appRow(a.id))!.envEnc)).toEqual({ SMTP_PASS: SECRET_VALUE, FEATURE_FLAG: "on" });

    for (const res of [await call(listApps, "GET", "/api/apps"), await callWithParams(getApp, "GET", "/x", undefined, p(a.id)), m]) {
      expect(JSON.stringify(res.json)).not.toContain(SECRET_VALUE);
    }
    expect((await callWithParams(getApp, "GET", "/x", undefined, p(a.id))).json.app).toMatchObject({ envKeys: ["FEATURE_FLAG", "SMTP_PASS"] });
    const [audit] = await auditOf(a.id, "app.env_updated");
    expect(JSON.stringify(audit!.details)).not.toContain(SECRET_VALUE);

    // names the platform sets, bad names and multi-line values are refused
    for (const bad of [{ PORT: "1" }, { DATABASE_URL: "x" }, { lower: "x" }, { OK: "a\nb" }, { set: { APP_SECRET: "x" } }]) {
      expect((await callWithParams(putEnv, "PUT", "/x", bad, p(a.id))).status, JSON.stringify(bad)).toBe(400);
    }
    // a plain object replaces everything; {} clears it
    expect((await callWithParams(putEnv, "PUT", "/x", {}, p(a.id))).json).toEqual({ envKeys: [] });
    expect((await appRow(a.id))!.envEnc).toBeNull();
  });

  it("the preview password is made on first view, every view is audited, and rotating changes it", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const v1 = await callWithParams(viewAccess, "GET", "/x", undefined, p(a.id));
    expect(v1.status).toBe(200);
    expect(v1.json.username).toBe("preview");
    const pw = String(v1.json.password);
    expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    const row = (await appRow(a.id))!;
    expect(row.accessPasswordEnc).toMatch(/^v1:/);
    expect(row.accessPasswordEnc).not.toContain(pw);
    const v2 = await callWithParams(viewAccess, "GET", "/x", undefined, p(a.id));
    expect(v2.json.password).toBe(pw);
    expect(await auditOf(a.id, "app.access_viewed")).toHaveLength(2);
    // the password never shows up in the app's DTO
    expect(JSON.stringify((await callWithParams(getApp, "GET", "/x", undefined, p(a.id))).json)).not.toContain(pw);

    const rot = await callWithParams(rotateAccess, "POST", "/x", {}, p(a.id));
    expect(rot.status).toBe(200);
    expect(rot.json.password).not.toBe(pw);
    expect((await callWithParams(viewAccess, "GET", "/x", undefined, p(a.id))).json.password).toBe(rot.json.password);
    expect(await auditOf(a.id, "app.access_rotated")).toHaveLength(1);
    // a stopped app keeps the new password until it starts: nothing is published now
    expect(rot.json.republished).toBe(false);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("a running preview is published again when its password rotates or its access mode changes", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp({ status: "running" });
    const rot = await callWithParams(rotateAccess, "POST", "/x", {}, p(a.id));
    expect(rot.json.republished).toBe(true);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, action: "republish", userId: o.userId });
    deploy.mockReset();
    await callWithParams(patchApp, "PATCH", "/x", { accessMode: "public" }, p(a.id));
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, action: "republish", userId: o.userId });
    deploy.mockReset();
    // a branch change alone waits for the next deploy
    await callWithParams(patchApp, "PATCH", "/x", { branch: "feature/y" }, p(a.id));
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe("apps: deploy, rollback, stop, start, delete", () => {
  it("deploy creates a queued release and its job; a second one is refused while it waits", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp({ branch: "main" });
    const r = await callWithParams(deployApp, "POST", "/x", {}, p(a.id));
    expect(r.status).toBe(200);
    const rel = r.json.release as Record<string, unknown>;
    expect(rel).toMatchObject({ appId: a.id, status: "queued", trigger: "manual", branch: "main", commit: "", createdByName: "ADMIN person" });
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, String(rel.id)));
    expect(row).toMatchObject({ status: "queued", trigger: "manual", createdBy: o.userId, workspaceId: o.wsId });
    expect(deploy).toHaveBeenCalledWith({ kind: "release", releaseId: rel.id, workspaceId: o.wsId });
    expect(queueModule.publish).toHaveBeenCalledWith(o.wsId, { type: "release.updated", releaseId: rel.id, appId: a.id, status: "queued", step: null });
    expect(await auditOf(a.id, "app.deploy_requested")).toHaveLength(1);

    const again = await callWithParams(deployApp, "POST", "/x", { commit: SHA }, p(a.id));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("app_deploy_running");
    // also while the worker runs it
    await db.update(appReleases).set({ status: "deploying" }).where(eq(appReleases.id, String(rel.id)));
    expect((await callWithParams(deployApp, "POST", "/x", {}, p(a.id))).json.code).toBe("app_deploy_running");
    expect(deploy).toHaveBeenCalledTimes(1);

    // once it is done: an exact commit, or another branch
    await db.update(appReleases).set({ status: "deployed" }).where(eq(appReleases.id, String(rel.id)));
    const exact = await callWithParams(deployApp, "POST", "/x", { commit: SHA }, p(a.id));
    expect(exact.json.release).toMatchObject({ commit: SHA, branch: "main" });
    await db.update(appReleases).set({ status: "failed" }).where(eq(appReleases.id, String((exact.json.release as { id: string }).id)));
    const branch = await callWithParams(deployApp, "POST", "/x", { branch: "feature/y" }, p(a.id));
    expect(branch.json.release).toMatchObject({ commit: "", branch: "feature/y" });
    expect((await callWithParams(deployApp, "POST", "/x", { branch: "x", commit: SHA }, p(a.id))).status).toBe(400);
    expect((await callWithParams(deployApp, "POST", "/x", { commit: "abc" }, p(a.id))).status).toBe(400);
  });

  it("the kill switch, demo mode and a server that is not ready refuse deploy, rollback and start", async () => {
    const o = await signIn("ADMIN");
    const { server, insertApp } = await fixture(o.wsId);
    const a = await insertApp({ status: "stopped" });
    const old = await addRelease(a.id, o.wsId, { status: "superseded" });
    const cur = await addRelease(a.id, o.wsId, { commit: SHA2 });
    await db.update(apps).set({ currentReleaseId: cur.id }).where(eq(apps.id, a.id));
    const tries = async () => [
      await callWithParams(deployApp, "POST", "/x", {}, p(a.id)),
      await callWithParams(rollbackApp, "POST", "/x", { releaseId: old.id }, p(a.id)),
      await callWithParams(startApp, "POST", "/x", {}, p(a.id)),
    ];
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, o.wsId));
    for (const r of await tries()) {
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("apps_kill_switch");
    }
    await db.update(workspaces).set({ killSwitch: false, demoMode: true }).where(eq(workspaces.id, o.wsId));
    for (const r of await tries()) expect(r.json.code).toBe("apps_demo_mode");
    await db.update(workspaces).set({ demoMode: false }).where(eq(workspaces.id, o.wsId));
    await db.update(servers).set({ status: "error" }).where(eq(servers.id, server.id));
    const [dep, rb] = await tries();
    expect(dep!.json.code).toBe("server_not_ready");
    expect(rb!.json.code).toBe("server_not_ready");
    expect(deploy.mock.calls.filter(([j]) => j.kind === "release")).toHaveLength(0);
    expect(await db.select().from(appReleases).where(eq(appReleases.appId, a.id))).toHaveLength(2);
    // stopping is never refused by the kill switch
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, o.wsId));
    await db.update(apps).set({ status: "running" }).where(eq(apps.id, a.id));
    expect((await callWithParams(stopApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
  });

  it("rollback brings back a release that ran, never the current one or one that failed", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp({ status: "running" });
    const other = await insertApp();
    const old = await addRelease(a.id, o.wsId, { status: "superseded", commitSubject: "First version", manifest: { type: "nextjs", install: "pnpm i", build: "pnpm build", start: "pnpm start", health: "/api/health", database: false, memoryMb: 512 } });
    const failed = await addRelease(a.id, o.wsId, { status: "failed", commit: SHA2 });
    const cur = await addRelease(a.id, o.wsId, { commit: SHA2 });
    const foreign = await addRelease(other.id, o.wsId);
    await db.update(apps).set({ currentReleaseId: cur.id }).where(eq(apps.id, a.id));

    const codes = async (releaseId: string) => (await callWithParams(rollbackApp, "POST", "/x", { releaseId }, p(a.id))).json.code;
    expect(await codes(failed.id)).toBe("release_not_rollbackable");
    expect(await codes(cur.id)).toBe("release_is_current");
    expect(await codes(foreign.id)).toBe("release_not_found");
    expect(await codes("nope")).toBe("release_not_found");

    const r = await callWithParams(rollbackApp, "POST", "/x", { releaseId: old.id }, p(a.id));
    expect(r.status).toBe(200);
    const rel = r.json.release as { id: string };
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, rel.id));
    expect(row).toMatchObject({ trigger: "rollback", status: "queued", rollbackOfId: old.id, commit: SHA, branch: "main", commitSubject: "First version", manifest: old.manifest });
    expect(deploy).toHaveBeenCalledWith({ kind: "release", releaseId: rel.id, workspaceId: o.wsId });
    expect(await codes(old.id)).toBe("app_deploy_running");
  });

  it("stop and start enqueue app actions; start needs a version and a stopped app", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const fresh = await insertApp();
    expect((await callWithParams(stopApp, "POST", "/x", {}, p(fresh.id))).json.code).toBe("app_not_running");
    expect((await callWithParams(startApp, "POST", "/x", {}, p(fresh.id))).json.code).toBe("app_never_deployed");

    const a = await insertApp({ status: "running" });
    const rel = await addRelease(a.id, o.wsId);
    await db.update(apps).set({ currentReleaseId: rel.id }).where(eq(apps.id, a.id));
    expect((await callWithParams(startApp, "POST", "/x", {}, p(a.id))).json.code).toBe("app_already_running");
    expect((await callWithParams(stopApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, action: "stop", userId: o.userId });
    await db.update(apps).set({ status: "stopped" }).where(eq(apps.id, a.id));
    expect((await callWithParams(startApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, action: "start", userId: o.userId });
    expect(await auditOf(a.id, "app.stop_requested")).toHaveLength(1);
    expect(await auditOf(a.id, "app.start_requested")).toHaveLength(1);
  });

  it("the Owner stops every running preview of the workspace", async () => {
    const o = await signIn("OWNER");
    const { insertApp } = await fixture(o.wsId);
    const run1 = await insertApp({ status: "running" });
    const run2 = await insertApp({ status: "deploying" });
    await insertApp({ status: "stopped" });
    await insertApp({ status: "new" });
    const r = await call(stopAll, "POST", "/api/apps/stop-all");
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(2);
    expect(deploy.mock.calls.map(([j]) => j).sort((x, y) => ((x as { appId: string }).appId < (y as { appId: string }).appId ? -1 : 1))).toEqual(
      [run1.id, run2.id].sort().map((appId) => ({ kind: "app_action", appId, workspaceId: o.wsId, action: "stop", userId: o.userId })),
    );
    expect(await auditOf(o.wsId, "app.stop_all")).toHaveLength(1);
  });

  it("delete needs a fresh step-up, then the worker removes the app (once)", async () => {
    const o = await withTwoFactor("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const no = await callWithParams(deleteApp, "DELETE", "/x", undefined, p(a.id));
    expect(no.status).toBe(401);
    expect(no.json.code).toBe("step_up_required");
    expect(deploy).not.toHaveBeenCalled();
    await o.stepUp();
    expect((await callWithParams(deleteApp, "DELETE", "/x", undefined, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, action: "remove", userId: o.userId });
    expect(await auditOf(a.id, "app.remove_requested")).toHaveLength(1);
    const twice = await callWithParams(deleteApp, "DELETE", "/x", undefined, p(a.id));
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe("app_removing");
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it("an Admin without 2FA cannot delete", async () => {
    const o = await signIn("ADMIN");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const r = await callWithParams(deleteApp, "DELETE", "/x", undefined, p(a.id));
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("two_factor_required");
  });
});

describe("apps: detail and servers", () => {
  it("the detail lists the latest releases (no logs) with the current one on the app", async () => {
    const o = await signIn("VIEWER");
    const { insertApp } = await fixture(o.wsId);
    const a = await insertApp({ status: "running", healthy: true, envEnc: null });
    const old = await addRelease(a.id, o.wsId, { status: "superseded", createdAt: new Date(Date.now() - 60_000) });
    const cur = await addRelease(a.id, o.wsId, { commit: SHA2, warnings: ["first_publish"], manifest: { type: "nextjs", install: "i", build: "b", start: "s", health: "/", database: true, memoryMb: 512 } });
    await db.update(apps).set({ currentReleaseId: cur.id }).where(eq(apps.id, a.id));
    const r = await callWithParams(getApp, "GET", "/x", undefined, p(a.id));
    expect(r.status).toBe(200);
    expect(r.json.app).toMatchObject({ status: "running", healthy: true, hasDatabase: true, currentRelease: { id: cur.id, commit: SHA2, warnings: ["first_publish"] } });
    const releases = r.json.releases as { id: string }[];
    expect(releases.map((x) => x.id)).toEqual([cur.id, old.id]);
    expect(JSON.stringify(r.json)).not.toContain("== build ==");
    expect(releases[0]).not.toHaveProperty("log");
    expect(releases[0]).not.toHaveProperty("manifest");
  });

  it("a server with apps cannot be deleted", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    await insertApp();
    await o.stepUp();
    const r = await callWithParams(deleteServer, "DELETE", "/x", undefined, p(server.id));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("server_has_apps");
    expect(r.json.count).toBe(1);
    expect(String(r.json.error)).toContain("app");
    expect(await db.select().from(servers).where(eq(servers.id, server.id))).toHaveLength(1);
  });

  it("a server with apps keeps its address and domain (renaming is fine)", async () => {
    const o = await signIn("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    await insertApp();
    for (const body of [{ host: "45.77.10.21" }, { port: 2222 }, { username: "deploy" }, { baseDomain: "other.example.com" }]) {
      const r = await callWithParams(patchServer, "PATCH", "/x", body, p(server.id));
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("server_has_apps");
    }
    expect((await callWithParams(patchServer, "PATCH", "/x", { name: "Renamed server" }, p(server.id))).status).toBe(200);
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0]).toMatchObject({ host: "45.77.10.20", status: "ready", name: "Renamed server" });
  });
});
