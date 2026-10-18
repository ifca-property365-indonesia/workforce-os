import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { appDocuments, appDocumentTasks, appEnvironments, appReleases, apps, appTests, appTestUsers, db, servers } from "@wfos/db";
import { APP_PORT_MIN } from "@wfos/shared";
import { runTask } from "../src/runner/task";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner, type MockStep } from "../src/runner/mock-sdk";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

const LONG = "## Ringkasan\n\nAplikasi pengadaan untuk tim procurement: permintaan, persetujuan, pesanan pembelian.\n";

async function setup() {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id, { toolPermissions: [{ tool: "kb_search", enabled: true }] });
  const [server] = await db.insert(servers).values({ workspaceId: ws.id, name: "dev", host: "203.0.113.9", baseDomain: "p.example.com", status: "ready" }).returning();
  const slug = `doc-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws.id, name: "Procurement", slug }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId: ws.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 560 + Math.floor(Math.random() * 230) })
    .returning();
  await db.insert(appTestUsers).values({ environmentId: env!.id, workspaceId: ws.id, role: "approver", label: "Approver", username: "a@test", viewAll: true });
  return { ws, emp, app: app!, env: env! };
}
async function docTask(s: Awaited<ReturnType<typeof setup>>, kind: "prd" | "flow" | "test_guide" | "deck") {
  const task = await makeTask(s.ws.id, s.emp.id, { title: `Write the ${kind}` });
  await db.insert(appDocumentTasks).values({ taskId: task.id, workspaceId: s.ws.id, appId: s.app.id, kind });
  return task;
}
const save = (input: Record<string, unknown>): MockStep => ({ tool: "mcp__wfos__save_app_document", input });
const versions = (appId: string, kind: string) => db.select().from(appDocuments).where(and(eq(appDocuments.appId, appId), eq(appDocuments.kind, kind as "prd"))).orderBy(asc(appDocuments.version));

describe("app documents (C9)", () => {
  it("a document task saves drafts as new versions; the approved one is kept and given as the base, with releases since", async () => {
    const s = await setup();
    await db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, kind: "prd", version: 1, title: "PRD v1", content: `# PRD${LONG}`, status: "approved", decidedAt: new Date(Date.now() - 3600_000) });
    await db.insert(appReleases).values({ appId: s.app.id, workspaceId: s.ws.id, environmentId: s.env.id, commit: "b".repeat(40), branch: "main", status: "deployed", trigger: "manual", commitSubject: "Add vendor rating" });
    const task = await docTask(s, "prd");
    const mock = mockRunner([save({ title: "PRD v2", content: `# PRD${LONG}## Riwayat perubahan\n- vendor rating`, note: "vendor rating built" }), { result: "Saved." }]);
    setQueryImpl(mock.query as QueryFn);
    await runTask(task.id);

    expect(mock.lastPrompt).toContain("current-prd-v1");
    expect(mock.lastPrompt).toContain("bbbbbbbb — Add vendor rating");
    expect(mock.lastPrompt).toContain("[belum dibangun]");
    expect(mock.calls[0]!.output).toMatch(/Saved version 2 of the PRD as a draft/);
    const rows = await versions(s.app.id, "prd");
    expect(rows.map((r) => [r.version, r.status, r.basedOnVersion])).toEqual([
      [1, "approved", null],
      [2, "draft", 1],
    ]);
    expect(rows[1]).toMatchObject({ taskId: task.id, authorEmployeeId: s.emp.id, note: "vendor rating built" });
  });

  it("a business flow gets the approved PRD as data and the flow rules; a deck links the latest test's screenshots", async () => {
    const s = await setup();
    await db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, kind: "prd", version: 3, title: "PRD", content: `# PRD${LONG}`, status: "approved" });
    const flow = await docTask(s, "flow");
    const m1 = mockRunner([save({ title: "Alur bisnis", content: `# Alur bisnis: Procurement\n${LONG}\`\`\`alur\nmulai: butuh barang\nRequester: buat permintaan\nselesai: PO terbit\n\`\`\`` }), { result: "ok" }]);
    setQueryImpl(m1.query as QueryFn);
    await runTask(flow.id);
    expect(m1.lastPrompt).toContain("approved-prd-v3");
    expect(m1.lastPrompt).toContain("fenced block with the language `alur`");
    expect(m1.lastPrompt).toContain("approver: Approver (sees everything)");
    expect((await versions(s.app.id, "flow")).map((r) => r.version)).toEqual([1]);

    const [test] = await db.insert(appTests).values({ workspaceId: s.ws.id, appId: s.app.id, environmentId: s.env.id, status: "passed", summary: "all flows work" }).returning();
    const deck = await docTask(s, "deck");
    const m2 = mockRunner([save({ title: "Deck", content: `# Procurement\n${LONG}\n---\n## Persetujuan\n![Approve](#1)` }), { result: "ok" }]);
    setQueryImpl(m2.query as QueryFn);
    await runTask(deck.id);
    expect(m2.lastPrompt).toContain("Latest app test: all flows work");
    const [d] = await versions(s.app.id, "deck");
    expect(d).toMatchObject({ version: 1, testId: test!.id, status: "draft" });
  });

  it("only a document task has save_app_document, and a too-short document is refused", async () => {
    const s = await setup();
    const plain = await makeTask(s.ws.id, s.emp.id);
    const m1 = mockRunner([save({ title: "PRD", content: LONG.repeat(2) }), { result: "x" }]);
    setQueryImpl(m1.query as QueryFn);
    await runTask(plain.id);
    expect(await versions(s.app.id, "prd")).toEqual([]);

    const task = await docTask(s, "test_guide");
    const m2 = mockRunner([save({ title: "Guide", content: "too short" }), { result: "x" }]);
    setQueryImpl(m2.query as QueryFn);
    await runTask(task.id);
    expect(m2.calls[0]!.output).toMatch(/Invalid document: content/);
    expect(await versions(s.app.id, "test_guide")).toEqual([]);
  });
});
