import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { appDocuments, appEnvironments, appModules, appReleases, apps, appTests, db, employees, members, servers, steps, teams, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as attention } from "@/app/api/dashboard/attention/route";
import { POST as suggest } from "@/app/api/tasks/suggest-division/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `a-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "U", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.21", baseDomain: "p.example.com", status: "ready" }).returning();
  const env = async (appId: string, slug: string, kind: "preview" | "live", v: Partial<typeof appEnvironments.$inferInsert> = {}) =>
    (await db.insert(appEnvironments).values({ appId, workspaceId: ws!.id, kind, serverId: server!.id, instanceName: `${slug}-${kind}`, domain: `${slug}-${kind}.p.example.com`, port: APP_PORT_MIN + 300 + Math.floor(Math.random() * 600), ...v }).returning())[0]!;
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, env };
}
const app = async (wsId: string, name: string) => (await db.insert(apps).values({ workspaceId: wsId, name, slug: `a-${randomUUID().slice(0, 6)}` }).returning())[0]!;

describe("home: needs attention", () => {
  it("names the apps that are not well, waiting module work, unhandled findings and this week's spend", async () => {
    const s = await setup("VIEWER");
    const ok = await app(s.ws.id, "Sehat");
    await s.env(ok.id, ok.slug, "preview", { status: "running", healthy: true });
    const sick = await app(s.ws.id, "Property365");
    await s.env(sick.id, sick.slug, "preview", { status: "running", healthy: false });
    const live = await s.env(sick.id, sick.slug, "live", { status: "running", healthy: true, uptimeStatus: "down", certExpiresAt: new Date(Date.now() + 3 * 86_400_000) });
    await db.insert(appReleases).values({ appId: sick.id, workspaceId: s.ws.id, environmentId: live.id, commit: "a".repeat(40), branch: "main", status: "failed", trigger: "manual" });
    // an older failure followed by a good release is not a problem any more
    const fine = await app(s.ws.id, "Pulih");
    const fineEnv = await s.env(fine.id, fine.slug, "preview", { status: "running", healthy: true });
    await db.insert(appReleases).values({ appId: fine.id, workspaceId: s.ws.id, environmentId: fineEnv.id, commit: "b".repeat(40), branch: "main", status: "failed", trigger: "manual", createdAt: new Date(Date.now() - 3600_000) });
    await db.insert(appReleases).values({ appId: fine.id, workspaceId: s.ws.id, environmentId: fineEnv.id, commit: "c".repeat(40), branch: "main", status: "deployed", trigger: "manual" });

    const [m] = await db.insert(appModules).values({ workspaceId: s.ws.id, appId: sick.id, name: "Faktur", slug: "faktur", pendingWork: { role: "build", employeeId: null, teamId: null, note: "", requestedBy: null, requestedAt: new Date().toISOString() } }).returning();
    await db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: sick.id, moduleId: m!.id, kind: "prd", version: 1, title: "PRD", content: "x".repeat(60) });
    await db.insert(appTests).values({ appId: sick.id, workspaceId: s.ws.id, environmentId: live.id, status: "findings", commit: "a".repeat(40), findings: [] });
    await db.insert(steps).values([
      { workspaceId: s.ws.id, kind: "llm", name: "llm_call", credits: 30 },
      { workspaceId: s.ws.id, kind: "llm", name: "llm_call", credits: 20, createdAt: new Date(Date.now() - 10 * 86_400_000) },
    ]);

    const r = await callWithParams(attention, "GET", "/api/dashboard/attention", undefined, {});
    expect(r.status).toBe(200);
    expect(r.json.apps).toEqual([
      {
        id: sick.id,
        name: "Property365",
        problems: expect.arrayContaining([
          { env: "preview", problem: "unhealthy" },
          { env: "live", problem: "down" },
          { env: "live", problem: "cert_expiring" },
          { env: "live", problem: "release_failed" },
        ]),
      },
    ]);
    expect(r.json).toMatchObject({ modules: { prdDrafts: 1, waiting: 1, building: 0 }, findings: 1, spend: { last7: 30, prev7: 20 } });
  });

  it("suggests the division a request sounds like, among divisions with a head", async () => {
    const s = await setup("MEMBER");
    const [head] = await db.insert(employees).values({ workspaceId: s.ws.id, name: "Wulan", role: "Finance Lead", model: "m" }).returning();
    const [fin] = await db.insert(teams).values({ workspaceId: s.ws.id, name: "Finance & Accounting", key: "finance", description: "Faktur dan pajak.", leadId: head!.id }).returning();
    await db.insert(teams).values({ workspaceId: s.ws.id, name: "Delivery", key: "delivery", description: "Produk." });
    const r = await callWithParams(suggest, "POST", "/api/tasks/suggest-division", { text: "Buat faktur IPL Oktober dan cek pajaknya" }, {});
    expect(r.json.suggestion).toMatchObject({ id: fin!.id, name: "Finance & Accounting", confident: true });
    // Delivery has no head: never suggested
    const none = await callWithParams(suggest, "POST", "/api/tasks/suggest-division", { text: "Ada bug di halaman login aplikasi" }, {});
    expect(none.json.suggestion).toBeNull();
  });
});
