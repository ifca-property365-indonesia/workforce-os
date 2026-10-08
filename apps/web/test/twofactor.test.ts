import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, employees, members, users, workspaces } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup } from "@/app/api/me/2fa/setup/route";
import { POST as enable } from "@/app/api/me/2fa/enable/route";
import { POST as disable } from "@/app/api/me/2fa/disable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { GET as settingsGet } from "@/app/api/settings/route";
import { PATCH as patchEmployee } from "@/app/api/employees/[id]/route";
import { POST as createEmployee } from "@/app/api/employees/route";
import { getSession } from "@/lib/server/auth";
import { requireStepUp } from "@/lib/server/twofactor";
import { call, callWithParams, jar, resetBrowser } from "./browser";

const PASSWORD = "correct horse battery";

async function makeUser(opts: { role?: "OWNER" | "ADMIN" | "MEMBER"; require2fa?: boolean } = {}) {
  const email = `u-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "Test", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: opts.require2fa ?? false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: opts.role ?? "MEMBER" });
  return { user: u!, ws: ws!, email };
}

/** Enroll through the real endpoints; returns the secret and recovery codes. */
async function enroll(email: string) {
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  const s = await call(setup, "POST", "/api/me/2fa/setup");
  expect(s.status).toBe(200);
  expect(String(s.json.qrDataUrl)).toMatch(/^data:image\/png;base64,/);
  const secret = String(s.json.secret);
  // the first code confirms; use the previous step so later tests can use the current one (no replay)
  const e = await call(enable, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) });
  expect(e.status).toBe(200);
  jar.clear();
  return { secret, recoveryCodes: e.json.recoveryCodes as string[] };
}

beforeEach(() => resetBrowser());

describe("login with 2FA", () => {
  it("without 2FA the password alone signs in", async () => {
    const { email } = await makeUser();
    expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
    expect(await getSession()).not.toBeNull();
  });

  it("stores the secret encrypted and the recovery codes hashed", async () => {
    const { email, user } = await makeUser();
    const { secret, recoveryCodes } = await enroll(email);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.totpSecretEnc).not.toContain(secret);
    expect(decryptSecret(row!.totpSecretEnc!)).toBe(secret);
    expect(row!.recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(JSON.stringify(row!.recoveryCodes)).not.toContain(c.replace("-", ""));
  });

  it("with 2FA the password alone does not create a session", async () => {
    const { email } = await makeUser();
    const { secret } = await enroll(email);
    const r = await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect(r.json.twoFactorRequired).toBe(true);
    expect(await getSession()).toBeNull();
    expect((await call(login2fa, "POST", "/api/auth/login/2fa", { code: "000000" })).status).toBe(401);
    expect(await getSession()).toBeNull();
    expect((await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) })).status).toBe(200);
    expect(await getSession()).not.toBeNull();
  });

  it("rejects a replayed code", async () => {
    const { email } = await makeUser();
    const { secret } = await enroll(email);
    const code = totp(secret);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await call(login2fa, "POST", "/api/auth/login/2fa", { code })).status).toBe(200);
    jar.clear();
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await call(login2fa, "POST", "/api/auth/login/2fa", { code })).status).toBe(401);
  });

  it("the second step needs the password step first", async () => {
    const { email } = await makeUser();
    const { secret } = await enroll(email);
    const r = await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("two_factor_challenge_expired");
  });

  it("a recovery code works exactly once", async () => {
    const { email } = await makeUser();
    const { recoveryCodes } = await enroll(email);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    const ok = await call(login2fa, "POST", "/api/auth/login/2fa", { recoveryCode: recoveryCodes[0] });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodesLeft).toBe(9);
    jar.clear();
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await call(login2fa, "POST", "/api/auth/login/2fa", { recoveryCode: recoveryCodes[0] })).status).toBe(401);
  });
});

describe("lockout", () => {
  it("locks after 5 failed passwords and says when to try again", async () => {
    const { email } = await makeUser();
    for (let i = 0; i < 4; i++) expect((await call(login, "POST", "/api/auth/login", { email, password: "wrong" })).status).toBe(401);
    const fifth = await call(login, "POST", "/api/auth/login", { email, password: "wrong" });
    expect(fifth.status).toBe(423);
    expect(fifth.json.code).toBe("account_locked");
    const until = new Date(String(fifth.json.lockedUntil)).getTime();
    expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(String(fifth.json.error)).toMatch(/Try again at/);
    // even the right password is refused while locked
    expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(423);
  });

  it("wrong second-factor codes count toward the lockout", async () => {
    const { email } = await makeUser();
    await enroll(email);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call(login2fa, "POST", "/api/auth/login/2fa", { code: "123456" })).status;
    expect(last).toBe(423);
    expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(423);
  });

  it("a successful sign-in resets the failure counter", async () => {
    const { email, user } = await makeUser();
    for (let i = 0; i < 3; i++) await call(login, "POST", "/api/auth/login", { email, password: "wrong" });
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.failedLoginCount).toBe(0);
  });
});

describe("mandatory 2FA for Owners and Admins", () => {
  it("blocks every other API until an admin enrolls", async () => {
    const { email } = await makeUser({ role: "ADMIN", require2fa: true });
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await getSession())!.mustEnroll2fa).toBe(true);
    const blocked = await call(settingsGet, "GET", "/api/settings");
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("two_factor_enrollment_required");
    expect((await call(setup, "POST", "/api/me/2fa/setup")).status).toBe(200);
  });

  it("does not apply to members", async () => {
    const { email } = await makeUser({ role: "MEMBER", require2fa: true });
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await getSession())!.mustEnroll2fa).toBe(false);
  });

  it("does not apply when the workspace setting is off", async () => {
    const { email } = await makeUser({ role: "OWNER", require2fa: false });
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    expect((await getSession())!.mustEnroll2fa).toBe(false);
  });

  it("cannot be turned off while required", async () => {
    const { email, ws } = await makeUser({ role: "OWNER", require2fa: false });
    const { secret } = await enroll(email);
    await db.update(workspaces).set({ require2faAdmins: true }).where(eq(workspaces.id, ws.id));
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
    const r = await call(disable, "POST", "/api/me/2fa/disable", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) });
    expect(r.status).toBe(403);
  });
});

describe("re-authentication", () => {
  it("disabling 2FA needs the password and a current code", async () => {
    const { email, user } = await makeUser();
    const { secret } = await enroll(email);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
    expect((await call(disable, "POST", "/api/me/2fa/disable", { password: "wrong", code: totp(secret, Date.now() + 30_000) })).status).toBe(400);
    expect((await call(disable, "POST", "/api/me/2fa/disable", { password: PASSWORD, code: "000000" })).status).toBe(400);
    expect((await call(disable, "POST", "/api/me/2fa/disable", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.totpSecretEnc).toBeNull();
  });

  it("step-up is required for sensitive changes and granted by password + code", async () => {
    const { email } = await makeUser();
    const { secret } = await enroll(email);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
    const session = (await getSession())!;
    await expect(requireStepUp(session)).rejects.toMatchObject({ status: 401, extra: { code: "step_up_required" } });
    expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
    await expect(requireStepUp(session)).resolves.toBeUndefined();
  });

  it("step-up is refused without 2FA", async () => {
    const { email } = await makeUser();
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    await expect(requireStepUp((await getSession())!)).rejects.toMatchObject({ extra: { code: "two_factor_required" } });
  });
});

describe("Workspace mode needs Owner/Admin and a fresh 2FA confirmation", () => {
  async function adminWith2fa(role: "ADMIN" | "MEMBER" = "ADMIN") {
    const { email, ws } = await makeUser({ role });
    const { secret } = await enroll(email);
    await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
    await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "Dewi", role: "Developer", model: "claude-sonnet-5-5" }).returning();
    return { secret, emp: emp! };
  }

  it("refuses the switch without a step-up, allows it after one", async () => {
    const { secret, emp } = await adminWith2fa();
    const r1 = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { executionMode: "workspace" }, { id: emp.id });
    expect(r1.status).toBe(401);
    expect(r1.json.code).toBe("step_up_required");
    expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
    const r2 = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { executionMode: "workspace" }, { id: emp.id });
    expect(r2.status).toBe(200);
    expect((r2.json.employee as { executionMode: string }).executionMode).toBe("workspace");
  });

  it("refuses members entirely", async () => {
    const { emp } = await adminWith2fa("MEMBER");
    const r = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { executionMode: "workspace" }, { id: emp.id });
    expect(r.status).toBe(403);
  });

  it("needs a step-up to widen the egress allow-list, not to narrow it", async () => {
    const { emp } = await adminWith2fa();
    const wider = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { egressDomains: ["registry.npmjs.org"] }, { id: emp.id });
    expect(wider.status).toBe(401);
    const same = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { egressDomains: [] }, { id: emp.id });
    expect(same.status).toBe(200);
  });

  it("refuses hiring straight into Workspace mode without a step-up", async () => {
    await adminWith2fa();
    const r = await call(createEmployee, "POST", "/api/employees", { name: "X", role: "Developer", executionMode: "workspace" });
    expect(r.status).toBe(401);
  });

  it("rejects egress entries that are not host names", async () => {
    const { emp } = await adminWith2fa();
    for (const bad of ["127.0.0.1", "http://evil.com", "*", "evil.com:22", "localhost"]) {
      const r = await callWithParams(patchEmployee, "PATCH", `/api/employees/${emp.id}`, { egressDomains: [bad] }, { id: emp.id });
      expect(r.status, bad).toBe(400);
    }
  });
});
