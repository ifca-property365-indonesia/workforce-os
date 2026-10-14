import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, appReleases, apps, auditLog, clients, db, members, projects, repositories, servers, users, workspaces } from "@wfos/db";
import { APP_PORT_MAX, APP_PORT_MIN, WFOS_HELPER_VERSION, type AppEnvironmentKind, type DomainCheck, type ServerInfo } from "@wfos/shared";
import { checkDomains } from "@wfos/shared/dns";
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
import { DELETE as deleteLive, PATCH as patchLive, POST as createLive } from "@/app/api/apps/[id]/live/route";
import { POST as dnsCheckLive } from "@/app/api/apps/[id]/live/dns-check/route";
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

// public DNS is never asked in tests: the shared check is replaced, each test says what DNS answers
vi.mock("@wfos/shared/dns", () => ({ checkDomains: vi.fn() }));
const dns = vi.mocked(checkDomains);
const dnsAnswer = (status: DomainCheck["status"], names: string[], expected = ["45.77.10.20"]): DomainCheck => ({
  status,
  expected,
  names: names.map((name) => ({ name, status, found: status === "ok" ? expected : status === "wrong" ? ["203.0.113.9"] : [] })),
  checkedAt: new Date().toISOString(),
});

const deploy = vi.mocked(queueModule.q.deploy);

beforeEach(() => {
  resetBrowser();
  deploy.mockReset();
  vi.mocked(queueModule.publish).mockClear();
  dns.mockReset();
  dns.mockImplementation(async (names) => dnsAnswer("missing", names));
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

type AppInsert = typeof apps.$inferInsert;
type EnvInsert = typeof appEnvironments.$inferInsert;
const APP_KEYS = ["name", "slug", "branch", "clientId", "projectId", "repositoryId"] as const;

/**
 * a ready server and a repository in the workspace, plus a helper to insert apps straight into the tables: the app
 * row and its preview environment (fields of either may be given; the app keeps only its own)
 */
async function fixture(wsId: string) {
  const server = await addServer(wsId);
  const repo = await addRepo(wsId, "develop");
  let n = 0;
  const insertApp = async (over: Partial<Pick<AppInsert, (typeof APP_KEYS)[number]>> & Partial<Omit<EnvInsert, "appId" | "workspaceId" | "kind">> = {}) => {
    n += 1;
    const slug = over.slug ?? `app${n}-${randomUUID().slice(0, 4)}`;
    const appOver = Object.fromEntries(Object.entries(over).filter(([k]) => (APP_KEYS as readonly string[]).includes(k)));
    const envOver = Object.fromEntries(Object.entries(over).filter(([k]) => !(APP_KEYS as readonly string[]).includes(k)));
    const [a] = await db
      .insert(apps)
      .values({ workspaceId: wsId, repositoryId: repo.id, name: `App ${slug}`, slug, ...appOver })
      .returning();
    const [env] = await db
      .insert(appEnvironments)
      .values({ appId: a!.id, workspaceId: wsId, kind: "preview", serverId: server.id, instanceName: slug, domain: `${slug}.${server.baseDomain}`, port: APP_PORT_MIN + 200 + n, ...envOver })
      .returning();
    return { ...a!, env: env! };
  };
  return { server, repo, insertApp };
}

/** the environment of that kind of an app */
const envRow = async (appId: string, kind: AppEnvironmentKind = "preview") =>
  (await db.select().from(appEnvironments).where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.kind, kind))))[0];
const setEnv = async (appId: string, set: Partial<EnvInsert>, kind: AppEnvironmentKind = "preview") =>
  db.update(appEnvironments).set(set).where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.kind, kind)));

/** a release in the app's preview environment unless another environmentId is given */
async function addRelease(appId: string, wsId: string, over: Partial<typeof appReleases.$inferInsert> = {}) {
  const environmentId = over.environmentId ?? (await envRow(appId))!.id;
  const [r] = await db
    .insert(appReleases)
    .values({ appId, workspaceId: wsId, environmentId, commit: SHA, branch: "main", status: "deployed", trigger: "manual", log: "== build ==\nok\n", ...over })
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
      branch: "develop",
      clientId: c!.id,
      projectId: proj!.id,
      repositoryName: repo.name,
      live: null,
      preview: {
        kind: "preview",
        domain: `shop.${server.baseDomain}`,
        url: `https://shop.${server.baseDomain}`,
        extraDomains: [],
        port: APP_PORT_MIN,
        status: "new",
        accessMode: "password",
        serverId: server.id,
        serverName: server.name,
        envKeys: [],
        hasDatabase: false,
        memoryMb: 512,
        currentRelease: null,
        dnsCheck: null,
      },
    });
    // the app row keeps only its own fields; the preview environment has the rest
    const preview = (await envRow(String(a.id)))!;
    expect(preview).toMatchObject({ instanceName: "shop", serverId: server.id, workspaceId: o.wsId, port: APP_PORT_MIN, createdBy: o.userId });
    expect(await appRow(String(a.id))).toMatchObject({ serverId: null, domain: null, port: null });
    expect(await auditOf(String(a.id), "app.created")).toHaveLength(1);
    expect(queueModule.publish).toHaveBeenCalledWith(o.wsId, { type: "app.updated", appId: a.id, status: "new", environmentId: preview.id });
    // nothing runs until a deploy
    expect(deploy).not.toHaveBeenCalled();

    const list = await call(listApps, "GET", "/api/apps");
    expect((list.json.apps as { id: string }[]).map((x) => x.id)).toEqual([a.id]);
  });

  it("refuses reserved and taken slugs, a taken name, a server that is not ready and links of other workspaces", async () => {
    const o = await signIn("ADMIN");
    const { server, repo, insertApp } = await fixture(o.wsId);
    const base = { name: "X", serverId: server.id, repositoryId: repo.id };
    for (const slug of ["www", "api", "admin", "-x", "a--b", "UPPER", "x", "shop-live"]) {
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
    const portOf = (r: { json: Record<string, unknown> }) => (r.json.app as { preview: { port: number } }).preview.port;
    const r1 = await call(createApp, "POST", "/api/apps", { name: "One", slug: "one", serverId: server.id, repositoryId: repo.id });
    expect(portOf(r1)).toBe(APP_PORT_MIN + 1);
    const r2 = await call(createApp, "POST", "/api/apps", { name: "Two", slug: "two", serverId: server.id, repositoryId: repo.id });
    expect(portOf(r2)).toBe(APP_PORT_MIN + 3);
    // another server's ports are its own
    const s2 = await addServer(o.wsId);
    const r3 = await call(createApp, "POST", "/api/apps", { name: "Three", slug: "three", serverId: s2.id, repositoryId: repo.id });
    expect(portOf(r3)).toBe(APP_PORT_MIN);

    // fill every port of a third server
    const full = await addServer(o.wsId);
    const rows = [];
    for (let port = APP_PORT_MIN; port <= APP_PORT_MAX; port++) rows.push({ workspaceId: o.wsId, repositoryId: repo.id, name: `f${port}`, slug: `f${port}` });
    const made = await db.insert(apps).values(rows).returning({ id: apps.id, slug: apps.slug });
    await db.insert(appEnvironments).values(
      made.map((m, i) => ({ appId: m.id, workspaceId: o.wsId, kind: "preview" as const, serverId: full.id, instanceName: m.slug, domain: `${m.slug}.${full.baseDomain}`, port: APP_PORT_MIN + i })),
    );
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
    expect(r.json.app).toMatchObject({ name: "Renamed", branch: "feature/x", clientId: c!.id, projectId: null, preview: { accessMode: "public" } });
    expect((await envRow(a.id))!.accessMode).toBe("public");
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
    await setEnv(a.id, { currentReleaseId: rel.id });
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
    expect(await appRow(theirs.id)).toMatchObject({ name: theirs.name });
    expect(await envRow(theirs.id)).toMatchObject({ status: "running" });
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
    const row = (await envRow(a.id))!;
    expect(row.envEnc).toMatch(/^v1:/);
    expect(row.envEnc).not.toContain(SECRET_VALUE);

    // merge: a new name and a removal keep the untouched value
    const m = await callWithParams(putEnv, "PUT", "/x", { set: { FEATURE_FLAG: "on" }, remove: ["SMTP_HOST"] }, p(a.id));
    expect(m.json).toEqual({ envKeys: ["FEATURE_FLAG", "SMTP_PASS"] });
    const { readEnv } = await import("@/lib/server/apps");
    expect(readEnv((await envRow(a.id))!.envEnc)).toEqual({ SMTP_PASS: SECRET_VALUE, FEATURE_FLAG: "on" });

    for (const res of [await call(listApps, "GET", "/api/apps"), await callWithParams(getApp, "GET", "/x", undefined, p(a.id)), m]) {
      expect(JSON.stringify(res.json)).not.toContain(SECRET_VALUE);
    }
    expect((await callWithParams(getApp, "GET", "/x", undefined, p(a.id))).json.app).toMatchObject({ preview: { envKeys: ["FEATURE_FLAG", "SMTP_PASS"] } });
    const [audit] = await auditOf(a.id, "app.env_updated");
    expect(JSON.stringify(audit!.details)).not.toContain(SECRET_VALUE);

    // names the platform sets, bad names and multi-line values are refused
    for (const bad of [{ PORT: "1" }, { DATABASE_URL: "x" }, { lower: "x" }, { OK: "a\nb" }, { set: { APP_SECRET: "x" } }]) {
      expect((await callWithParams(putEnv, "PUT", "/x", bad, p(a.id))).status, JSON.stringify(bad)).toBe(400);
    }
    // a plain object replaces everything; {} clears it
    expect((await callWithParams(putEnv, "PUT", "/x", {}, p(a.id))).json).toEqual({ envKeys: [] });
    expect((await envRow(a.id))!.envEnc).toBeNull();
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
    const row = (await envRow(a.id))!;
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
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "republish", userId: o.userId });
    deploy.mockReset();
    await callWithParams(patchApp, "PATCH", "/x", { accessMode: "public" }, p(a.id));
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "republish", userId: o.userId });
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
    expect(rel).toMatchObject({ appId: a.id, environmentId: a.env.id, environmentKind: "preview", promotedFromReleaseId: null, status: "queued", trigger: "manual", branch: "main", commit: "", createdByName: "ADMIN person" });
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, String(rel.id)));
    expect(row).toMatchObject({ status: "queued", trigger: "manual", createdBy: o.userId, workspaceId: o.wsId, environmentId: a.env.id });
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
    await setEnv(a.id, { currentReleaseId: cur.id });
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
    await setEnv(a.id, { status: "running" });
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
    await setEnv(a.id, { currentReleaseId: cur.id });

    const codes = async (releaseId: string) => (await callWithParams(rollbackApp, "POST", "/x", { releaseId }, p(a.id))).json.code;
    expect(await codes(failed.id)).toBe("release_not_rollbackable");
    expect(await codes(cur.id)).toBe("release_is_current");
    expect(await codes(foreign.id)).toBe("release_not_found");
    expect(await codes("nope")).toBe("release_not_found");

    const r = await callWithParams(rollbackApp, "POST", "/x", { releaseId: old.id }, p(a.id));
    expect(r.status).toBe(200);
    const rel = r.json.release as { id: string };
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, rel.id));
    expect(row).toMatchObject({ trigger: "rollback", status: "queued", rollbackOfId: old.id, environmentId: a.env.id, commit: SHA, branch: "main", commitSubject: "First version", manifest: old.manifest });
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
    await setEnv(a.id, { currentReleaseId: rel.id });
    expect((await callWithParams(startApp, "POST", "/x", {}, p(a.id))).json.code).toBe("app_already_running");
    expect((await callWithParams(stopApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "stop", userId: o.userId });
    await setEnv(a.id, { status: "stopped" });
    expect((await callWithParams(startApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "start", userId: o.userId });
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
      [run1, run2].sort((x, y) => (x.id < y.id ? -1 : 1)).map((a) => ({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "stop", userId: o.userId })),
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
    await setEnv(a.id, { currentReleaseId: cur.id });
    const r = await callWithParams(getApp, "GET", "/x", undefined, p(a.id));
    expect(r.status).toBe(200);
    expect(r.json.app).toMatchObject({ preview: { status: "running", healthy: true, hasDatabase: true, currentRelease: { id: cur.id, commit: SHA2, warnings: ["first_publish"], environmentKind: "preview" } }, live: null });
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

/** a live environment straight into the table (the route's own rules are tested through POST /live) */
async function addLive(appId: string, wsId: string, serverId: string, over: Partial<EnvInsert> = {}) {
  const [a] = await db.select().from(apps).where(eq(apps.id, appId));
  const [env] = await db
    .insert(appEnvironments)
    .values({
      appId,
      workspaceId: wsId,
      kind: "live",
      serverId,
      instanceName: `${a!.slug}-live`,
      domain: `${a!.slug}-${randomUUID().slice(0, 6)}.client.example`,
      port: APP_PORT_MAX - Math.floor(Math.random() * 150),
      accessMode: "public",
      ...over,
    })
    .returning();
  return env!;
}

const live = (id: string) => `/api/apps/${id}/live`;

describe("apps: the live environment", () => {
  it("only the Owner sets it up, with a fresh step-up; it gets its own instance, port, public access and a DNS check", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    const a = await insertApp({ slug: `guest${randomUUID().slice(0, 4)}` });
    const liveServer = await addServer(o.wsId, { role: "live", host: "198.51.100.7" });
    const input = { serverId: liveServer.id, domain: "BukuTamu.Client.Example ", extraDomains: ["www.bukutamu.client.example"] };
    dns.mockImplementation(async (names) => dnsAnswer("missing", names, ["198.51.100.7"]));

    const noStepUp = await callWithParams(createLive, "POST", live(a.id), input, p(a.id));
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.json.code).toBe("step_up_required");
    await o.stepUp();
    const r = await callWithParams(createLive, "POST", live(a.id), input, p(a.id));
    expect(r.status).toBe(200);
    expect(r.json.app).toMatchObject({
      id: a.id,
      preview: { kind: "preview", serverId: server.id },
      live: {
        kind: "live",
        serverId: liveServer.id,
        serverName: liveServer.name,
        domain: "bukutamu.client.example",
        extraDomains: ["www.bukutamu.client.example"],
        url: "https://bukutamu.client.example",
        port: APP_PORT_MIN,
        status: "new",
        accessMode: "public",
        memoryMb: 512,
        envKeys: [],
        currentRelease: null,
        dnsCheck: { status: "missing", expected: ["198.51.100.7"] },
      },
    });
    expect(dns).toHaveBeenCalledWith(["bukutamu.client.example", "www.bukutamu.client.example"], "198.51.100.7");
    const row = (await envRow(a.id, "live"))!;
    expect(row).toMatchObject({ instanceName: `${a.slug}-live`, workspaceId: o.wsId, createdBy: o.userId, envEnc: null, accessPasswordEnc: null, dbPasswordEnc: null });
    expect(await auditOf(a.id, "app.live_created")).toHaveLength(1);
    // nothing runs yet
    expect(deploy).not.toHaveBeenCalled();
    // one per app
    const again = await callWithParams(createLive, "POST", live(a.id), { ...input, domain: "other.client.example", extraDomains: [] }, p(a.id));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("live_exists");
  });

  it("Admins and below cannot set it up; another workspace's app or server is not found", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const input = { serverId: server.id, domain: "app.client.example" };
    for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
      await signIn(role, ws.id);
      const r = await callWithParams(createLive, "POST", live(a.id), input, p(a.id));
      expect(r.status, role).toBe(403);
      expect(r.json.code).toBe("role_required");
    }
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    const other = await workspace();
    const { server: theirServer, insertApp: insertTheirs } = await fixture(other.id);
    const theirs = await insertTheirs();
    expect((await callWithParams(createLive, "POST", live(theirs.id), input, p(theirs.id))).json.code).toBe("app_not_found");
    expect((await callWithParams(createLive, "POST", live(a.id), { ...input, serverId: theirServer.id }, p(a.id))).json.code).toBe("server_not_found");
    const pending = await addServer(ws.id, { status: "pending" });
    expect((await callWithParams(createLive, "POST", live(a.id), { ...input, serverId: pending.id }, p(a.id))).json.code).toBe("server_not_ready");
    expect(await envRow(a.id, "live")).toBeUndefined();
  });

  it("refuses preview names, bad or doubled names, too many aliases and names another environment uses", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    await o.stepUp();
    const a = await insertApp();
    const b = await insertApp();
    const bLive = await addLive(b.id, o.wsId, server.id, { domain: "shop.client.example", extraDomains: ["www.shop.client.example"] });
    const code = async (body: Record<string, unknown>) => {
      const r = await callWithParams(createLive, "POST", live(a.id), { serverId: server.id, ...body }, p(a.id));
      return { status: r.status, code: r.json.code };
    };
    // the preview domain itself and anything under it (also another server's)
    const elsewhere = await addServer(o.wsId);
    expect(await code({ domain: server.baseDomain })).toEqual({ status: 409, code: "domain_is_preview" });
    expect(await code({ domain: `x.${server.baseDomain}` })).toEqual({ status: 409, code: "domain_is_preview" });
    expect(await code({ domain: "ok.client.example", extraDomains: [`www.${elsewhere.baseDomain}`] })).toEqual({ status: 409, code: "domain_is_preview" });
    // taken: another live domain or one of its extra names
    expect(await code({ domain: bLive.domain })).toEqual({ status: 409, code: "domain_taken" });
    expect(await code({ domain: "new.client.example", extraDomains: ["www.shop.client.example"] })).toEqual({ status: 409, code: "domain_taken" });
    // malformed, doubled, too many
    for (const domain of ["localhost", "http://x.example", "*.client.example", "10.0.0.1", "a b.example", "-x.example"]) {
      expect((await code({ domain })).status, domain).toBe(400);
    }
    expect(await code({ domain: "dup.client.example", extraDomains: ["dup.client.example"] })).toEqual({ status: 400, code: "domain_duplicate" });
    expect((await code({ domain: "many.client.example", extraDomains: ["a.client.example", "b.client.example", "c.client.example", "d.client.example"] })).status).toBe(400);
    expect(await envRow(a.id, "live")).toBeUndefined();
    // a sibling name of the preview's parent domain is fine (bukutamu.<parent> while previews are <slug>.preview.<parent>)
    const parent = server.baseDomain.split(".").slice(1).join(".");
    expect((await code({ domain: `bukutamu.${parent}` })).status).toBe(200);
  });

  it("refuses the platform's own names and the servers' host names (domain_reserved)", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    await o.stepUp();
    const a = await insertApp();
    // another workspace's server, reached by name: its host is no live domain either
    const other = await workspace();
    await addServer(other.id, { host: "box7.hosting.example" });
    const { serverEnv } = await import("@/lib/server/env");
    const before = serverEnv.appUrl;
    // http keeps the test session cookie as it is (https would switch to secure cookie names)
    (serverEnv as { appUrl: string }).appUrl = "http://workforce-os.property365.example:3010";
    try {
      const code = async (domain: string, extraDomains: string[] = []) => {
        const r = await callWithParams(createLive, "POST", live(a.id), { serverId: server.id, domain, extraDomains }, p(a.id));
        return r.json.code ?? r.status;
      };
      for (const d of [
        "box7.hosting.example",
        "workforce-os.property365.example",
        "property365.example",
        "api.workforce-os.property365.example",
        "airis.workforce-os.property365.example",
        "www.property365.example",
        "login.property365.example",
      ]) {
        expect(await code(d), d).toBe("domain_reserved");
      }
      expect(await code("shop.client.example", ["www.workforce-os.property365.example"])).toBe("domain_reserved");
      expect(await envRow(a.id, "live")).toBeUndefined();
      // a client's app under the platform's host is fine
      expect(await code("bukutamu.workforce-os.property365.example")).toBe(200);
    } finally {
      (serverEnv as { appUrl: string }).appUrl = before;
    }
  });

  it("two setups claiming the same name at once: one wins, also when one claims it as an extra name", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    await o.stepUp();
    const a = await insertApp();
    const b = await insertApp();
    const [ra, rb] = await Promise.all([
      callWithParams(createLive, "POST", live(a.id), { serverId: server.id, domain: "race.client.example" }, p(a.id)),
      callWithParams(createLive, "POST", live(b.id), { serverId: server.id, domain: "other-race.client.example", extraDomains: ["race.client.example"] }, p(b.id)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra.json.code, rb.json.code]).toContain("domain_taken");
    const claimed = await db.select().from(appEnvironments).where(eq(appEnvironments.kind, "live"));
    expect(claimed.filter((e) => e.domain === "race.client.example" || e.extraDomains.includes("race.client.example"))).toHaveLength(1);
  });

  it("the Release to LIVE dialog learns which live env names changed since the version live now", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const env = await addLive(a.id, ws.id, server.id);
    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    await callWithParams(putEnv, "PUT", "/x?env=live", { OLD_KEY: "1", KEEP: "1" }, p(a.id));
    expect((await callWithParams(getApp, "GET", "/x", undefined, p(a.id))).json.liveEnvChanged).toEqual([]);
    const cur = await addRelease(a.id, ws.id, { environmentId: env.id, startedAt: new Date(Date.now() - 1000) });
    await setEnv(a.id, { currentReleaseId: cur.id }, "live");
    await callWithParams(putEnv, "PUT", "/x?env=live", { set: { NEW_KEY: "2", KEEP: "2" }, remove: ["OLD_KEY"] }, p(a.id));
    // a preview change is not a live change
    await callWithParams(putEnv, "PUT", "/x", { PREVIEW_ONLY: "1" }, p(a.id));
    const r = await callWithParams(getApp, "GET", "/x", undefined, p(a.id));
    expect(r.json.liveEnvChanged).toEqual(["KEEP", "NEW_KEY", "OLD_KEY"]);
    expect(JSON.stringify(r.json)).not.toContain('"2"');
  });

  it("an Admin checks DNS: the shared check runs against the live server and its result is stored", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const noLive = await insertApp();
    const env = await addLive(a.id, ws.id, server.id, { domain: "dns.client.example", extraDomains: ["www.dns.client.example"] });
    await signIn("MEMBER", ws.id);
    expect((await callWithParams(dnsCheckLive, "POST", "/x", {}, p(a.id))).status).toBe(403);
    await signIn("ADMIN", ws.id);
    expect((await callWithParams(dnsCheckLive, "POST", "/x", {}, p(noLive.id))).json.code).toBe("live_not_found");
    dns.mockImplementation(async (names) => dnsAnswer("ok", names));
    const r = await callWithParams(dnsCheckLive, "POST", "/x", {}, p(a.id));
    expect(r.status).toBe(200);
    expect(dns).toHaveBeenCalledWith(["dns.client.example", "www.dns.client.example"], server.host);
    expect(r.json.dnsCheck).toMatchObject({ status: "ok", expected: ["45.77.10.20"] });
    expect((await envRow(a.id, "live"))!.dnsCheck).toMatchObject({ status: "ok", names: [{ name: "dns.client.example", status: "ok" }, { name: "www.dns.client.example", status: "ok" }] });
    expect((r.json.app as { live: { dnsCheck: { status: string } } }).live.dnsCheck.status).toBe("ok");
    expect(await auditOf(a.id, "app.live_dns_checked")).toHaveLength(1);
    expect(env.id).toBe((await envRow(a.id, "live"))!.id);
  });

  it("release to live: the Owner with a step-up, a commit that ran in the preview, and DNS ok", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp({ status: "running" });
    const other = await insertApp();
    const env = await addLive(a.id, ws.id, server.id);
    const ran = await addRelease(a.id, ws.id, { status: "superseded", commit: SHA, commitSubject: "Guestbook v1", manifest: { type: "nextjs", install: "i", build: "b", start: "s", health: "/", database: true, memoryMb: 512 } });
    const failed = await addRelease(a.id, ws.id, { status: "failed", commit: SHA2 });
    const foreign = await addRelease(other.id, ws.id);
    const liveRel = await addRelease(a.id, ws.id, { environmentId: env.id, status: "failed" });
    const deployLive = (body: unknown) => callWithParams(deployApp, "POST", `/x?env=live`, body, p(a.id));

    await signIn("ADMIN", ws.id);
    const admin = await deployLive({ fromReleaseId: ran.id });
    expect(admin.status).toBe(403);
    expect(admin.json.code).toBe("role_required");
    const o = await withTwoFactor("OWNER", ws.id);
    expect((await deployLive({ fromReleaseId: ran.id })).json.code).toBe("step_up_required");
    await o.stepUp();
    expect((await deployLive({ branch: "main" })).status).toBe(400);
    expect((await deployLive({ fromReleaseId: failed.id })).json.code).toBe("live_needs_preview_release");
    expect((await deployLive({ fromReleaseId: foreign.id })).json.code).toBe("release_not_found");
    expect((await deployLive({ fromReleaseId: liveRel.id })).json.code).toBe("release_not_found");
    expect((await deployLive({ fromReleaseId: "nope" })).json.code).toBe("release_not_found");
    // DNS first
    expect((await deployLive({ fromReleaseId: ran.id })).json.code).toBe("live_dns_not_ok");
    await setEnv(a.id, { dnsCheck: dnsAnswer("wrong", [env.domain]) }, "live");
    expect((await deployLive({ fromReleaseId: ran.id })).json.code).toBe("live_dns_not_ok");
    await setEnv(a.id, { dnsCheck: dnsAnswer("ok", [env.domain]) }, "live");
    expect(deploy).not.toHaveBeenCalled();

    const r = await deployLive({ fromReleaseId: ran.id });
    expect(r.status).toBe(200);
    const rel = r.json.release as { id: string };
    expect(rel).toMatchObject({ environmentId: env.id, environmentKind: "live", promotedFromReleaseId: ran.id, commit: SHA, status: "queued", trigger: "manual" });
    const [row] = await db.select().from(appReleases).where(eq(appReleases.id, rel.id));
    expect(row).toMatchObject({ environmentId: env.id, appId: a.id, commit: SHA, branch: ran.branch, commitSubject: "Guestbook v1", manifest: ran.manifest, promotedFromReleaseId: ran.id, createdBy: o.userId });
    expect(deploy).toHaveBeenCalledWith({ kind: "release", releaseId: rel.id, workspaceId: ws.id });
    expect(await auditOf(a.id, "app.live_deploy_requested")).toHaveLength(1);
    // one live release at a time, while the preview deploys on its own
    expect((await deployLive({ fromReleaseId: ran.id })).json.code).toBe("app_deploy_running");
    expect((await callWithParams(deployApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    // the kill switch stops live releases too
    await db.update(appReleases).set({ status: "deployed" }).where(eq(appReleases.id, rel.id));
    await db.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.id, ws.id));
    expect((await deployLive({ fromReleaseId: ran.id })).json.code).toBe("apps_kill_switch");
  });

  it("live start and rollback are the Owner's with a step-up, start only with DNS ok; stopping live is the Owner's too", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const env = await addLive(a.id, ws.id, server.id, { status: "stopped", dnsCheck: dnsAnswer("ok", ["x"]) });
    const old = await addRelease(a.id, ws.id, { environmentId: env.id, status: "superseded" });
    const cur = await addRelease(a.id, ws.id, { environmentId: env.id, commit: SHA2 });
    const previewRel = await addRelease(a.id, ws.id, { status: "superseded" });
    await setEnv(a.id, { currentReleaseId: cur.id }, "live");
    await signIn("ADMIN", ws.id);
    for (const r of [
      await callWithParams(startApp, "POST", "/x?env=live", {}, p(a.id)),
      await callWithParams(rollbackApp, "POST", "/x?env=live", { releaseId: old.id }, p(a.id)),
    ]) {
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("role_required");
    }
    const o = await withTwoFactor("OWNER", ws.id);
    expect((await callWithParams(startApp, "POST", "/x?env=live", {}, p(a.id))).json.code).toBe("step_up_required");
    await o.stepUp();
    // a live start waits for DNS like a release does
    await setEnv(a.id, { dnsCheck: dnsAnswer("wrong", ["x"]) }, "live");
    expect((await callWithParams(startApp, "POST", "/x?env=live", {}, p(a.id))).json.code).toBe("live_dns_not_ok");
    await setEnv(a.id, { dnsCheck: null }, "live");
    expect((await callWithParams(startApp, "POST", "/x?env=live", {}, p(a.id))).json.code).toBe("live_dns_not_ok");
    expect(deploy).not.toHaveBeenCalled();
    await setEnv(a.id, { dnsCheck: dnsAnswer("ok", ["x"]) }, "live");
    expect((await callWithParams(startApp, "POST", "/x?env=live", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: ws.id, environmentId: env.id, action: "start", userId: o.userId });
    // a rollback stays inside its environment
    expect((await callWithParams(rollbackApp, "POST", "/x?env=live", { releaseId: previewRel.id }, p(a.id))).json.code).toBe("release_not_found");
    expect((await callWithParams(rollbackApp, "POST", "/x", { releaseId: old.id }, p(a.id))).json.code).toBe("release_not_found");
    const rb = await callWithParams(rollbackApp, "POST", "/x?env=live", { releaseId: old.id }, p(a.id));
    expect(rb.status).toBe(200);
    expect(rb.json.release).toMatchObject({ environmentId: env.id, environmentKind: "live", trigger: "rollback" });

    await setEnv(a.id, { status: "running" }, "live");
    await setEnv(a.id, { status: "running" });
    const admin = await signIn("ADMIN", ws.id);
    const adminStop = await callWithParams(stopApp, "POST", "/x?env=live", {}, p(a.id));
    expect(adminStop.status).toBe(403);
    expect(adminStop.json).toMatchObject({ code: "role_required", role: "OWNER" });
    // Admins still stop the preview
    expect((await callWithParams(stopApp, "POST", "/x", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: ws.id, environmentId: a.env.id, action: "stop", userId: admin.userId });
    const owner = await signIn("OWNER", ws.id);
    expect((await callWithParams(stopApp, "POST", "/x?env=live", {}, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: ws.id, environmentId: env.id, action: "stop", userId: owner.userId });
  });

  it("env values, passwords and env names are kept per environment; the live ones are the Owner's", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const lone = await insertApp();
    await addLive(a.id, ws.id, server.id, { accessMode: "password" });
    await signIn("ADMIN", ws.id);
    for (const r of [
      await callWithParams(putEnv, "PUT", "/x?env=live", { SMTP_PASS: SECRET_VALUE }, p(a.id)),
      await callWithParams(viewAccess, "GET", "/x?env=live", undefined, p(a.id)),
      await callWithParams(rotateAccess, "POST", "/x?env=live", {}, p(a.id)),
    ]) {
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ code: "role_required", role: "OWNER" });
    }
    expect(await envRow(a.id, "live")).toMatchObject({ envEnc: null, accessPasswordEnc: null });
    const o = await withTwoFactor("OWNER", ws.id);
    // writing live values and a new live password need a step-up; looking at the password does not
    expect((await callWithParams(putEnv, "PUT", "/x?env=live", { SMTP_PASS: SECRET_VALUE }, p(a.id))).json.code).toBe("step_up_required");
    expect((await callWithParams(rotateAccess, "POST", "/x?env=live", {}, p(a.id))).json.code).toBe("step_up_required");
    await o.stepUp();
    expect((await callWithParams(putEnv, "PUT", "/x?env=live", { SMTP_PASS: SECRET_VALUE }, p(a.id))).json).toEqual({ envKeys: ["SMTP_PASS"] });
    expect((await callWithParams(putEnv, "PUT", "/x", { PREVIEW_ONLY: "1" }, p(a.id))).json).toEqual({ envKeys: ["PREVIEW_ONLY"] });
    const { readEnv } = await import("@/lib/server/apps");
    expect(readEnv((await envRow(a.id, "live"))!.envEnc)).toEqual({ SMTP_PASS: SECRET_VALUE });
    expect(readEnv((await envRow(a.id))!.envEnc)).toEqual({ PREVIEW_ONLY: "1" });
    const got = await callWithParams(getApp, "GET", "/x", undefined, p(a.id));
    expect(got.json.app).toMatchObject({ preview: { envKeys: ["PREVIEW_ONLY"] }, live: { envKeys: ["SMTP_PASS"] } });
    expect(JSON.stringify(got.json)).not.toContain(SECRET_VALUE);
    const [envAudit] = await auditOf(a.id, "app.env_updated");
    expect(envAudit!.details).toMatchObject({ environment: "live" });

    const pv = await callWithParams(viewAccess, "GET", "/x", undefined, p(a.id));
    const lv = await callWithParams(viewAccess, "GET", "/x?env=live", undefined, p(a.id));
    expect(pv.json.password).not.toBe(lv.json.password);
    expect((await callWithParams(viewAccess, "GET", "/x?env=live", undefined, p(a.id))).json.password).toBe(lv.json.password);

    expect((await callWithParams(rotateAccess, "POST", "/x?env=live", {}, p(a.id))).json.password).not.toBe(lv.json.password);
    expect((await callWithParams(putEnv, "PUT", "/x?env=staging", { A: "b" }, p(a.id))).json.code).toBe("unknown_environment");
    expect((await callWithParams(putEnv, "PUT", "/x?env=live", { A: "b" }, p(lone.id))).json.code).toBe("live_not_found");
  });

  it("the live domain changes only while it is stopped, and a new name is checked again; access republishes", async () => {
    const o = await withTwoFactor("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const env = await addLive(a.id, o.wsId, server.id, { status: "running", dnsCheck: dnsAnswer("ok", ["old.client.example"]), domain: "old.client.example" });
    const running = await callWithParams(patchLive, "PATCH", live(a.id), { domain: "new.client.example" }, p(a.id));
    expect(running.status).toBe(409);
    expect(running.json.code).toBe("live_running_domain");
    expect(dns).not.toHaveBeenCalled();

    const pub = await callWithParams(patchLive, "PATCH", live(a.id), { accessMode: "password" }, p(a.id));
    expect(pub.status).toBe(200);
    expect(deploy).toHaveBeenLastCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: env.id, action: "republish", userId: o.userId });
    expect((await envRow(a.id, "live"))!.accessMode).toBe("password");

    await setEnv(a.id, { status: "stopped" }, "live");
    const moved = await callWithParams(patchLive, "PATCH", live(a.id), { domain: "new.client.example", extraDomains: ["www.new.client.example"] }, p(a.id));
    expect(moved.status).toBe(200);
    expect(dns).toHaveBeenCalledWith(["new.client.example", "www.new.client.example"], server.host);
    expect(await envRow(a.id, "live")).toMatchObject({ domain: "new.client.example", extraDomains: ["www.new.client.example"], dnsCheck: { status: "missing" } });
    expect(await auditOf(a.id, "app.live_updated")).toHaveLength(2);
    // the same rules as at setup
    expect((await callWithParams(patchLive, "PATCH", live(a.id), { domain: `x.${server.baseDomain}` }, p(a.id))).json.code).toBe("domain_is_preview");

    await signIn("ADMIN", o.wsId);
    expect((await callWithParams(patchLive, "PATCH", live(a.id), { accessMode: "public" }, p(a.id))).status).toBe(403);
  });

  it("removing the live environment is the Owner's with a step-up and leaves the preview; deleting an app with one too", async () => {
    const ws = await workspace();
    const { server, insertApp } = await fixture(ws.id);
    const a = await insertApp();
    const env = await addLive(a.id, ws.id, server.id);
    const confirm = { confirm: env.domain };
    const admin = await withTwoFactor("ADMIN", ws.id);
    await admin.stepUp();
    expect((await callWithParams(deleteLive, "DELETE", live(a.id), confirm, p(a.id))).status).toBe(403);
    const whole = await callWithParams(deleteApp, "DELETE", "/x", confirm, p(a.id));
    expect(whole.status).toBe(403);
    expect(whole.json).toMatchObject({ code: "role_required", role: "OWNER" });
    expect(deploy).not.toHaveBeenCalled();

    const o = await withTwoFactor("OWNER", ws.id);
    await o.stepUp();
    // the live domain typed, and the live site stopped
    for (const body of [undefined, {}, { confirm: "wrong.client.example" }, { confirm: `x${env.domain}` }]) {
      const r = await callWithParams(deleteLive, "DELETE", live(a.id), body, p(a.id));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.code).toBe("confirm_mismatch");
      expect((await callWithParams(deleteApp, "DELETE", "/x", body, p(a.id))).json.code).toBe("confirm_mismatch");
    }
    for (const status of ["running", "deploying"] as const) {
      await setEnv(a.id, { status }, "live");
      expect((await callWithParams(deleteLive, "DELETE", live(a.id), confirm, p(a.id))).json.code).toBe("live_running");
      expect((await callWithParams(deleteApp, "DELETE", "/x", confirm, p(a.id))).json.code).toBe("live_running");
    }
    await setEnv(a.id, { status: "stopped" }, "live");
    expect(deploy).not.toHaveBeenCalled();
    expect((await callWithParams(deleteLive, "DELETE", live(a.id), { confirm: env.domain.toUpperCase() }, p(a.id))).status).toBe(200);
    expect(deploy).toHaveBeenCalledWith({ kind: "app_action", appId: a.id, workspaceId: ws.id, environmentId: env.id, action: "remove", userId: o.userId });
    expect(await auditOf(a.id, "app.live_remove_requested")).toHaveLength(1);
    // one removal of this app at a time, and nothing is deployed or started meanwhile
    expect((await callWithParams(deleteApp, "DELETE", "/x", confirm, p(a.id))).json.code).toBe("app_removing");
    await setEnv(a.id, { dnsCheck: dnsAnswer("ok", [env.domain]) }, "live");
    const ran = await addRelease(a.id, ws.id, { status: "superseded" });
    await addRelease(a.id, ws.id);
    for (const r of [
      await callWithParams(deployApp, "POST", "/x", {}, p(a.id)),
      await callWithParams(deployApp, "POST", "/x?env=live", { fromReleaseId: ran.id }, p(a.id)),
      await callWithParams(rollbackApp, "POST", "/x", { releaseId: ran.id }, p(a.id)),
      await callWithParams(startApp, "POST", "/x", {}, p(a.id)),
    ]) {
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("app_removing");
    }
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it("stop-all leaves live sites alone; the list shows both environments", async () => {
    const o = await signIn("OWNER");
    const { server, insertApp } = await fixture(o.wsId);
    const a = await insertApp({ status: "running" });
    const env = await addLive(a.id, o.wsId, server.id, { status: "running" });
    const r = await call(stopAll, "POST", "/api/apps/stop-all");
    expect(r.json.count).toBe(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith({ kind: "app_action", appId: a.id, workspaceId: o.wsId, environmentId: a.env.id, action: "stop", userId: o.userId });
    const list = await call(listApps, "GET", "/api/apps");
    expect(list.json.apps).toEqual([expect.objectContaining({ id: a.id, preview: expect.objectContaining({ id: a.env.id }), live: expect.objectContaining({ id: env.id, url: `https://${env.domain}` }) })]);
  });

  it("the detail lists both environments' releases, each naming its environment; a log names it too", async () => {
    const o = await signIn("MEMBER");
    const { server, insertApp } = await fixture(o.wsId);
    const a = await insertApp();
    const env = await addLive(a.id, o.wsId, server.id);
    const pr = await addRelease(a.id, o.wsId, { createdAt: new Date(Date.now() - 60_000) });
    const lr = await addRelease(a.id, o.wsId, { environmentId: env.id, promotedFromReleaseId: pr.id });
    const r = await callWithParams(getApp, "GET", "/x", undefined, p(a.id));
    expect((r.json.releases as { id: string; environmentKind: string }[]).map((x) => [x.id, x.environmentKind])).toEqual([
      [lr.id, "live"],
      [pr.id, "preview"],
    ]);
    const log = await callWithParams(getRelease, "GET", "/x", undefined, p(lr.id));
    expect(log.json.release).toMatchObject({ environmentId: env.id, environmentKind: "live", promotedFromReleaseId: pr.id });
  });

  it("a server that only holds a live environment cannot be deleted or moved", async () => {
    const o = await withTwoFactor("OWNER");
    const { server: devServer, insertApp } = await fixture(o.wsId);
    const liveServer = await addServer(o.wsId, { role: "live" });
    const a = await insertApp();
    await addLive(a.id, o.wsId, liveServer.id);
    await o.stepUp();
    const r = await callWithParams(deleteServer, "DELETE", "/x", undefined, p(liveServer.id));
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "server_has_apps", count: 1 });
    expect((await callWithParams(patchServer, "PATCH", "/x", { host: "45.77.10.99" }, p(liveServer.id))).json.code).toBe("server_has_apps");
    expect(devServer.id).not.toBe(liveServer.id);
  });
});
