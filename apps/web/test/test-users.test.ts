import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appEnvironments, apps, appTestUsers, auditLog, db, members, servers, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { DELETE as removeUser, GET as listUsers, POST as addUser } from "@/app/api/apps/[id]/test-users/route";
import { POST as reveal } from "@/app/api/apps/[id]/test-users/reveal/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

const TOTP = "JBSWY3DPEHPK3PXP";

async function setup(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `t-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "P", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.20", baseDomain: "p.example.com", status: "ready" }).returning();
  const slug = `tu-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws!.id, name: "Procurement", slug }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId: ws!.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 300 + Math.floor(Math.random() * 200), testPasswordEnc: encryptSecret("shared-pass-123"), testUsersAt: new Date(), testUsersNote: "seeded" })
    .returning();
  await db.insert(appTestUsers).values([
    { environmentId: env!.id, workspaceId: ws!.id, role: "admin", label: "Admin", username: "admin@test", viewAll: true },
    { environmentId: env!.id, workspaceId: ws!.id, role: "approver", label: "Approver", username: "approver@test", totpEnc: encryptSecret(TOTP), loginPath: "/login" },
  ]);
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, app: app!, env: env! };
}
const at = (appId: string, sub = "") => `/api/apps/${appId}/test-users${sub}`;

describe("preview test accounts (C10)", () => {
  it("members see the accounts without any secret", async () => {
    const { app } = await setup("MEMBER");
    const r = await callWithParams(listUsers, "GET", at(app.id), undefined, { id: app.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sharedPassword: true, lastRunNote: "seeded" });
    const list = r.json.users as Record<string, unknown>[];
    expect(list.map((u) => [u.role, u.username, u.hasTotp, u.viewAll, u.source])).toEqual([
      ["admin", "admin@test", false, true, "auto"],
      ["approver", "approver@test", true, false, "auto"],
    ]);
    expect(JSON.stringify(r.json)).not.toMatch(/shared-pass-123|JBSWY3DP/);
    // showing a password is an Admin's
    expect((await callWithParams(reveal, "POST", at(app.id, "/reveal"), { role: "admin" }, { id: app.id })).status).toBe(403);
  });

  it("an Admin sees the shared password and the code valid now, audited; the TOTP key never leaves", async () => {
    const { app } = await setup("ADMIN");
    const r = await callWithParams(reveal, "POST", at(app.id, "/reveal"), { role: "approver" }, { id: app.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ username: "approver@test", password: "shared-pass-123", loginPath: "/login" });
    expect([totp(TOTP, Date.now()), totp(TOTP, Date.now() - 30_000)]).toContain(r.json.code);
    expect(r.json.codeValidFor).toBeGreaterThan(0);
    expect(JSON.stringify(r.json)).not.toContain(TOTP);
    const noTotp = await callWithParams(reveal, "POST", at(app.id, "/reveal"), { role: "admin" }, { id: app.id });
    expect(noTotp.json).toMatchObject({ code: null, codeValidFor: null });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "app.test_user_viewed"), eq(auditLog.targetId, app.id)));
    expect(audits).toHaveLength(2);
    expect((await callWithParams(reveal, "POST", at(app.id, "/reveal"), { role: "nobody" }, { id: app.id })).status).toBe(404);
  });

  it("an Admin adds a manual account (own password, or the shared one), replaces one, and removes one", async () => {
    const { app, env } = await setup("ADMIN");
    const add = await callWithParams(addUser, "POST", at(app.id), { role: "finance", label: "Finance", username: "fin@test", password: "own-pass-1", loginPath: "/masuk" }, { id: app.id });
    expect(add.status).toBe(200);
    const [fin] = await db.select().from(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.role, "finance")));
    expect(fin).toMatchObject({ source: "manual", username: "fin@test", loginPath: "/masuk" });
    expect(decryptSecret(fin!.passwordEnc!)).toBe("own-pass-1");
    expect((await callWithParams(reveal, "POST", at(app.id, "/reveal"), { role: "finance" }, { id: app.id })).json.password).toBe("own-pass-1");

    // the same role again replaces it (and takes over an auto account of that role)
    expect((await callWithParams(addUser, "POST", at(app.id), { role: "admin", label: "Boss", username: "boss@test" }, { id: app.id })).status).toBe(200);
    const [boss] = await db.select().from(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.role, "admin")));
    expect(boss).toMatchObject({ source: "manual", username: "boss@test", passwordEnc: null });

    expect((await callWithParams(addUser, "POST", at(app.id), { role: "bad role", label: "x", username: "x" }, { id: app.id })).status).toBe(400);
    expect((await callWithParams(removeUser, "DELETE", at(app.id, "?role=finance"), undefined, { id: app.id })).status).toBe(200);
    expect((await callWithParams(removeUser, "DELETE", at(app.id, "?role=finance"), undefined, { id: app.id })).status).toBe(404);
  });

  it("without a shared password a manual account needs its own", async () => {
    const { app, env } = await setup("ADMIN");
    await db.update(appEnvironments).set({ testPasswordEnc: null }).where(eq(appEnvironments.id, env.id));
    const r = await callWithParams(addUser, "POST", at(app.id), { role: "ops", label: "Ops", username: "ops@test" }, { id: app.id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("test_password_required");
  });

  it("another workspace's app is not found", async () => {
    const other = await setup("ADMIN");
    await setup("ADMIN");
    expect((await callWithParams(listUsers, "GET", at(other.app.id), undefined, { id: other.app.id })).status).toBe(404);
  });
});
