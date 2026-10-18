import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appEnvironments, appReleases, appTestUsers, db } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { runRelease } from "../src/deploy/pipeline";
import { FakeServer, MANIFEST, fastDeploys, makeApp, makeRemote, queueRelease, serverInfo } from "./deploy-fixtures";
import { resetTransport } from "./transport";

// SSH is never real: the FakeServer answers like the helper
vi.mock("@wfos/shared/ssh", async (importOriginal) => {
  const real = await importOriginal<typeof import("@wfos/shared/ssh")>();
  return { ...real, sshExec: vi.fn(), sftpPut: vi.fn(), probeServer: vi.fn() };
});

let srv: FakeServer;
beforeEach(() => {
  resetTransport();
  srv = new FakeServer();
  srv.install();
  fastDeploys();
});

const TOTP = "JBSWY3DPEHPK3PXP";
const accounts = (users: unknown[]) => `seeding test accounts\n${JSON.stringify({ users, note: "seeded" })}\n`;
const envRow = async (id: string) => (await db.select().from(appEnvironments).where(eq(appEnvironments.id, id)))[0]!;
const usersOf = (envId: string) => db.select().from(appTestUsers).where(eq(appTestUsers.environmentId, envId)).orderBy(appTestUsers.role);
const logOf = async (id: string) => (await db.select().from(appReleases).where(eq(appReleases.id, id)))[0]!.log;

async function app(o: { helperVersion?: number; manifest?: Record<string, unknown> } = {}) {
  const repo = makeRemote({ "wfos-app.json": JSON.stringify({ ...MANIFEST, testUsers: "pnpm test-users", ...o.manifest }) });
  const f = await makeApp({ remote: repo.remote, server: { info: serverInfo({ helperVersion: o.helperVersion ?? 5 }) } });
  return { ...f, repo };
}

describe("test accounts on previews (C10)", () => {
  it("after the migration, before activation: stored per role, TOTP encrypted, the shared password in the env, nothing secret in the log", async () => {
    const { ws, app: a, preview, repo } = await app();
    srv.replies["build-run:test-users"] = {
      code: 0,
      stdout: accounts([
        { role: "admin", label: "Admin", username: "admin@test", viewAll: true },
        { role: "approver", label: "Approver", username: "approver@test", totp: TOTP, loginPath: "/login" },
      ]),
    };
    const rel = await queueRelease(a);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");

    const seq = srv.sequence();
    expect(seq.indexOf("build-run:test-users")).toBe(seq.indexOf("build-run:migrate") + 1);
    expect(seq.indexOf("build-run:test-users")).toBeLessThan(seq.indexOf("release-activate"));
    const call = srv.callsOf("build-run").find((c) => c.args[2] === "test-users")!;
    expect(call.args).toEqual([a.slug, repo.first, "test-users", "180", "1024"]);
    expect(call.stdin).toBe("pnpm test-users\n");

    const env = await envRow(preview.id);
    const pw = decryptSecret(env.testPasswordEnc!);
    expect(pw).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(srv.env).toContain(`WFOS_TEST_PASSWORD=${pw}\n`);
    expect(env.testUsersNote).toBe("seeded");

    const rows = await usersOf(preview.id);
    expect(rows.map((r) => ({ role: r.role, username: r.username, loginPath: r.loginPath, viewAll: r.viewAll, source: r.source }))).toEqual([
      { role: "admin", username: "admin@test", loginPath: "/", viewAll: true, source: "auto" },
      { role: "approver", username: "approver@test", loginPath: "/login", viewAll: false, source: "auto" },
    ]);
    expect(rows[0]!.totpEnc).toBeNull();
    expect(decryptSecret(rows[1]!.totpEnc!)).toBe(TOTP);

    const log = await logOf(rel.id);
    expect(log).toContain("test accounts: 2 role(s) (admin, approver)");
    expect(log).not.toContain(TOTP);
    expect(log).not.toContain(pw);
    expect(log).not.toContain("approver@test");
  });

  it("the next release replaces the script's accounts; a manual account keeps its role", async () => {
    const { ws, app: a, preview, repo } = await app();
    srv.replies["build-run:test-users"] = { code: 0, stdout: accounts([{ role: "old", label: "Old", username: "o1" }]) };
    expect(await runRelease((await queueRelease(a)).id, ws.id)).toBe("deployed");
    await db.insert(appTestUsers).values({ environmentId: preview.id, workspaceId: ws.id, role: "admin", label: "Mine", username: "me@test", source: "manual" });

    repo.commit({ "src/page.tsx": "export default function Page() { return 1; }\n" });
    srv.replies["build-run:test-users"] = { code: 0, stdout: accounts([{ role: "admin", label: "Admin", username: "a2" }, { role: "new", label: "New", username: "n2" }]) };
    const rel = await queueRelease(a);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    const rows = await usersOf(preview.id);
    expect(rows.map((r) => [r.role, r.username, r.source])).toEqual([
      ["admin", "me@test", "manual"],
      ["new", "n2", "auto"],
    ]);
    expect(await logOf(rel.id)).toContain("kept the manual admin");
  });

  it("a failing or unreadable script never fails the release: a warning, the accounts unchanged, no JSON line in the log", async () => {
    const { ws, app: a, preview, repo } = await app();
    srv.replies["build-run:test-users"] = { code: 1, stdout: `${JSON.stringify({ users: [{ role: "x", label: "X", username: "u", totp: TOTP }] })}\nboom: seed failed\n` };
    const rel = await queueRelease(a);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    const log = await logOf(rel.id);
    expect(log).toMatch(/warning: test accounts not updated: .*boom: seed failed/);
    expect(log).not.toContain(TOTP);
    expect(await usersOf(preview.id)).toEqual([]);
    expect((await envRow(preview.id)).testUsersNote).toMatch(/^failed: /);

    // a new commit (the running one is never released again)
    repo.commit({ "src/page.tsx": "export default function Page() { return 2; }\n" });
    srv.replies["build-run:test-users"] = { code: 0, stdout: "no json here\n" };
    const rel2 = await queueRelease(a);
    expect(await runRelease(rel2.id, ws.id)).toBe("deployed");
    expect(await logOf(rel2.id)).toContain("test accounts: not updated (the testUsers command printed no JSON line");
  });

  it("an older helper (v4) skips the step with a warning and the release goes on", async () => {
    const { ws, app: a, preview } = await app({ helperVersion: 4 });
    const rel = await queueRelease(a);
    expect(await runRelease(rel.id, ws.id)).toBe("deployed");
    expect(srv.sequence()).not.toContain("build-run:test-users");
    expect(await logOf(rel.id)).toMatch(/warning: test accounts skipped: .* version 5 is needed/);
    expect((await envRow(preview.id)).testUsersNote).toMatch(/older than version 5/);
  });

  it("an app without testUsers gets no test password and no step", async () => {
    const { ws, app: a, preview } = await app({ manifest: { testUsers: undefined } });
    expect(await runRelease((await queueRelease(a)).id, ws.id)).toBe("deployed");
    expect(srv.sequence()).not.toContain("build-run:test-users");
    expect((await envRow(preview.id)).testPasswordEnc).toBeNull();
    expect(srv.env).not.toContain("WFOS_TEST_PASSWORD");
  });
});
