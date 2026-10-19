import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appDocuments, appEnvironments, appModules, appModuleTasks, apps, clients, db, employees, members, repositories, servers, tasks, uiTemplates, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as catalog, POST as addTemplate } from "@/app/api/ui-templates/route";
import { DELETE as removeTemplate } from "@/app/api/ui-templates/[id]/route";
import { GET as preview } from "@/app/api/ui-templates/preview/route";
import { GET as getDesign, PUT as putDesign } from "@/app/api/apps/[id]/design/route";
import { PUT as putClientDesign } from "@/app/api/clients/[id]/design/route";
import { POST as restyle } from "@/app/api/apps/[id]/restyle/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

const DESIGN = "# Desain kami\n\nWarna utama biru tua, huruf Inter, tabel padat, sudut 6px, tanpa gradien.\n";

async function setup(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `u-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "U", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [dev] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Citra", role: "Frontend Developer", model: "m", executionMode: "workspace" }).returning();
  const [client] = await db.insert(clients).values({ workspaceId: ws!.id, name: "IFCA" }).returning();
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.21", baseDomain: "p.example.com", status: "ready" }).returning();
  const [repo] = await db.insert(repositories).values({ workspaceId: ws!.id, name: `r-${randomUUID().slice(0, 6)}`, provider: "github", url: "https://github.com/acme/p365.git" }).returning();
  const slug = `ui-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws!.id, name: "Property365", slug, clientId: client!.id, repositoryId: repo!.id }).returning();
  await db.insert(appEnvironments).values({ appId: app!.id, workspaceId: ws!.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 600 + Math.floor(Math.random() * 190) });
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, app: app!, client: client!, dev: dev! };
}

describe("UI templates (C5)", () => {
  it("lists the eight built-in kits and the workspace's own; previews are inert pages", async () => {
    await setup("ADMIN");
    const added = await callWithParams(addTemplate, "POST", "/api/ui-templates", { name: "IFCA Brand", design: DESIGN, tokensCss: ":root{--ui-primary:#0B3D91}</style><script>x</script>" }, {});
    expect(added.status).toBe(200);
    const c = await callWithParams(catalog, "GET", "/api/ui-templates", undefined, {});
    expect((c.json.builtin as { ref: string }[]).map((k) => k.ref)).toEqual(["korporat", "swiss", "material", "brutal", "malam", "editorial", "clay", "industri"]);
    expect(c.json.custom).toEqual([expect.objectContaining({ name: "IFCA Brand", ref: added.json.ref, hasPreview: true })]);
    expect((await callWithParams(addTemplate, "POST", "/api/ui-templates", { name: "IFCA Brand", design: DESIGN }, {})).json.code).toBe("ui_template_name_taken");

    const r = await preview(new (await import("next/server")).NextRequest("http://localhost/api/ui-templates/preview?ref=malam&screen=list"), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    const html = await r.text();
    expect(html).toContain("--ui-bg: #0B1020");
    expect(html).toContain("Tagihan IPL");
    const mine = await preview(new (await import("next/server")).NextRequest(`http://localhost/api/ui-templates/preview?ref=${added.json.ref}&screen=login`), { params: Promise.resolve({}) });
    const mineHtml = await mine.text();
    expect(mineHtml).toContain("--ui-primary:#0B3D91");
    expect(mineHtml).not.toContain("<script>x");
    expect((await preview(new (await import("next/server")).NextRequest("http://localhost/api/ui-templates/preview?ref=nope"), { params: Promise.resolve({}) })).status).toBe(404);
  });

  it("an app follows its client's look unless it sets its own; refs and Figma links are checked", async () => {
    // a template of another workspace
    const [otherWs] = await db.insert(workspaces).values({ name: "Other", slug: `ws-${randomUUID().slice(0, 8)}` }).returning();
    const [theirs] = await db.insert(uiTemplates).values({ workspaceId: otherWs!.id, name: "Theirs", design: DESIGN }).returning();
    const s = await setup("ADMIN");
    expect((await callWithParams(putClientDesign, "PUT", `/api/clients/${s.client.id}/design`, { uiTemplate: "editorial", figmaUrl: "https://www.figma.com/design/AbCdEfGhIjKl/IFCA" }, { id: s.client.id })).status).toBe(200);
    let d = await callWithParams(getDesign, "GET", `/api/apps/${s.app.id}/design`, undefined, { id: s.app.id });
    expect(d.json.effective).toMatchObject({ template: { ref: "editorial", from: "client", name: "Editorial", builtin: true }, figma: { from: "client" } });
    expect((await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: "malam" }, { id: s.app.id })).status).toBe(200);
    d = await callWithParams(getDesign, "GET", `/api/apps/${s.app.id}/design`, undefined, { id: s.app.id });
    expect(d.json.effective).toMatchObject({ template: { ref: "malam", from: "app", mode: "dark" }, figma: { from: "client" } });
    // another workspace's template, a made-up kit and a non-Figma link are refused
    expect((await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: `custom:${theirs!.id}` }, { id: s.app.id })).json.code).toBe("ui_template_not_found");
    expect((await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: "neon" }, { id: s.app.id })).status).toBe(400);
    expect((await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { figmaUrl: "https://evil.test/design/x" }, { id: s.app.id })).status).toBe(400);
  });

  it("a custom template in use cannot be removed; members cannot change templates", async () => {
    const s = await setup("ADMIN");
    const added = await callWithParams(addTemplate, "POST", "/api/ui-templates", { name: "Ours", design: DESIGN }, {});
    await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: added.json.ref }, { id: s.app.id });
    expect((await callWithParams(removeTemplate, "DELETE", `/api/ui-templates/${added.json.id}`, undefined, { id: added.json.id as string })).json.code).toBe("ui_template_in_use");
    await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: null }, { id: s.app.id });
    expect((await callWithParams(removeTemplate, "DELETE", `/api/ui-templates/${added.json.id}`, undefined, { id: added.json.id as string })).status).toBe(200);

    const m = await setup("MEMBER");
    expect((await callWithParams(putDesign, "PUT", `/api/apps/${m.app.id}/design`, { uiTemplate: "clay" }, { id: m.app.id })).status).toBe(403);
    expect((await callWithParams(addTemplate, "POST", "/api/ui-templates", { name: "Mine", design: DESIGN }, {})).status).toBe(403);
  });

  it("applying the look is a code task on the app's repository; not without a look, not while a module is built", async () => {
    const s = await setup("ADMIN");
    expect((await callWithParams(restyle, "POST", `/api/apps/${s.app.id}/restyle`, { employeeId: s.dev.id }, { id: s.app.id })).json.code).toBe("app_no_design");
    await callWithParams(putDesign, "PUT", `/api/apps/${s.app.id}/design`, { uiTemplate: "korporat" }, { id: s.app.id });
    const [m] = await db.insert(appModules).values({ workspaceId: s.ws.id, appId: s.app.id, name: "Faktur", slug: "faktur" }).returning();
    await db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, moduleId: m!.id, kind: "prd", version: 1, title: "PRD", content: DESIGN, status: "approved" });
    const [busy] = await db.insert(tasks).values({ workspaceId: s.ws.id, title: "Bangun Faktur", assigneeId: s.dev.id, status: "RUNNING", repositoryId: s.app.repositoryId }).returning();
    await db.insert(appModuleTasks).values({ taskId: busy!.id, moduleId: m!.id, workspaceId: s.ws.id, role: "build" });
    expect((await callWithParams(restyle, "POST", `/api/apps/${s.app.id}/restyle`, { employeeId: s.dev.id }, { id: s.app.id })).json.code).toBe("app_module_busy");
    await db.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, busy!.id));
    const r = await callWithParams(restyle, "POST", `/api/apps/${s.app.id}/restyle`, { employeeId: s.dev.id, note: "mulai dari dasbor" }, { id: s.app.id });
    expect(r.status).toBe(200);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(t).toMatchObject({ assigneeId: s.dev.id, repositoryId: s.app.repositoryId, status: "QUEUED" });
    expect(t!.brief).toContain('the UI template "Korporat"');
    expect(t!.brief).toContain("mulai dari dasbor");
  });
});
