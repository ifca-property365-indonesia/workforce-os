import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { appDocuments, appDocumentTasks, appEnvironments, appReleases, apps, auditLog, db, employees, members, servers, tasks, users, workspaces } from "@wfos/db";
import { APP_PORT_MIN, type Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listDocs } from "@/app/api/apps/[id]/documents/route";
import { GET as getDoc, POST as decide } from "@/app/api/apps/[id]/documents/[docId]/route";
import { POST as requestDoc } from "@/app/api/apps/[id]/documents/request/route";
import { GET as candidates, POST as importPrd } from "@/app/api/apps/[id]/documents/import/route";
import { GET as inbox } from "@/app/api/inbox/route";
import { callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

const BODY = "# PRD Procurement\n\n## Latar belakang\n\nTim procurement butuh alur permintaan dan persetujuan pembelian.\n";

async function setup(role: Role) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `d-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "P", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [pm] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Pratiwi", role: "Project Manager", model: "m" }).returning();
  const [server] = await db.insert(servers).values({ workspaceId: ws!.id, name: "dev", host: "45.77.10.21", baseDomain: "p.example.com", status: "ready" }).returning();
  const slug = `dc-${randomUUID().slice(0, 6)}`;
  const [app] = await db.insert(apps).values({ workspaceId: ws!.id, name: "Procurement", slug }).returning();
  const [env] = await db
    .insert(appEnvironments)
    .values({ appId: app!.id, workspaceId: ws!.id, kind: "preview", serverId: server!.id, instanceName: slug, domain: `${slug}.p.example.com`, port: APP_PORT_MIN + 600 + Math.floor(Math.random() * 190) })
    .returning();
  expect((await callWithParams(login, "POST", "/api/auth/login", { email, password: "pw-123456" }, {})).status).toBe(200);
  return { ws: ws!, app: app!, env: env!, pm: pm! };
}
const at = (appId: string, sub = "") => `/api/apps/${appId}/documents${sub}`;
const doc = (s: { ws: { id: string }; app: { id: string } }, v: Partial<typeof appDocuments.$inferInsert>) =>
  db.insert(appDocuments).values({ workspaceId: s.ws.id, appId: s.app.id, kind: "prd", version: 1, title: "PRD", content: BODY, ...v }).returning().then((r) => r[0]!);

describe("app documents (C9)", () => {
  it("lists versions per kind and how many preview releases came after the approved PRD", async () => {
    const s = await setup("MEMBER");
    await doc(s, { version: 1, status: "approved", decidedAt: new Date(Date.now() - 3600_000) });
    await doc(s, { version: 2, status: "draft" });
    await db.insert(appReleases).values({ appId: s.app.id, workspaceId: s.ws.id, environmentId: s.env.id, commit: "c".repeat(40), branch: "main", status: "deployed", trigger: "manual" });
    const r = await callWithParams(listDocs, "GET", at(s.app.id), undefined, { id: s.app.id });
    expect(r.status).toBe(200);
    const kinds = r.json.kinds as Record<string, { versions: { version: number; status: string }[]; approved: { version: number } | null; releasesSinceApproved: number }>;
    expect(kinds.prd!.versions.map((v) => [v.version, v.status])).toEqual([
      [2, "draft"],
      [1, "approved"],
    ]);
    expect(kinds.prd).toMatchObject({ approved: { version: 1 }, releasesSinceApproved: 1 });
    expect(kinds.flow).toMatchObject({ versions: [], approved: null, releasesSinceApproved: 0 });
  });

  it("an Admin approves a draft (the old approved one is replaced) or rejects one; members cannot; audited", async () => {
    const s = await setup("ADMIN");
    const v1 = await doc(s, { version: 1, status: "approved" });
    const v2 = await doc(s, { version: 2, content: `${BODY}\n## Baru\n` });
    const detail = await callWithParams(getDoc, "GET", at(s.app.id, `/${v2.id}`), undefined, { id: s.app.id, docId: v2.id });
    expect(detail.json).toMatchObject({ doc: { id: v2.id, version: 2 }, approved: { id: v1.id, version: 1 } });

    expect((await callWithParams(decide, "POST", at(s.app.id, `/${v2.id}`), { action: "approve" }, { id: s.app.id, docId: v2.id })).status).toBe(200);
    const rows = await db.select().from(appDocuments).where(eq(appDocuments.appId, s.app.id)).orderBy(asc(appDocuments.version));
    expect(rows.map((r) => r.status)).toEqual(["superseded", "approved"]);
    expect((await callWithParams(decide, "POST", at(s.app.id, `/${v2.id}`), { action: "reject" }, { id: s.app.id, docId: v2.id })).json.code).toBe("app_document_not_draft");
    const v3 = await doc(s, { version: 3 });
    expect((await callWithParams(decide, "POST", at(s.app.id, `/${v3.id}`), { action: "reject" }, { id: s.app.id, docId: v3.id })).status).toBe(200);
    expect((await db.select().from(appDocuments).where(eq(appDocuments.id, v3.id)))[0]!.status).toBe("rejected");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.targetId, s.app.id), eq(auditLog.action, "app.document_approved")))).toHaveLength(1);

    const m = await setup("MEMBER");
    const d = await doc(m, { version: 1 });
    expect((await callWithParams(decide, "POST", at(m.app.id, `/${d.id}`), { action: "approve" }, { id: m.app.id, docId: d.id })).status).toBe(403);
  });

  it("a member asks an employee for a document: a task linked to exactly that app and kind", async () => {
    const s = await setup("MEMBER");
    const r = await callWithParams(requestDoc, "POST", at(s.app.id, "/request"), { kind: "flow", employeeId: s.pm.id, note: "for the GOB pitch" }, { id: s.app.id });
    expect(r.status).toBe(200);
    const [link] = await db.select().from(appDocumentTasks).where(eq(appDocumentTasks.taskId, r.json.taskId as string));
    expect(link).toMatchObject({ appId: s.app.id, kind: "flow", workspaceId: s.ws.id });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(task).toMatchObject({ assigneeId: s.pm.id, status: "QUEUED" });
    expect(task!.brief).toContain("for the GOB pitch");
  });

  it("an Admin imports a PRD deliverable of a task as the next version (draft); drafts wait in Needs a decision", async () => {
    const s = await setup("ADMIN");
    const deliverableId = randomUUID();
    const [t] = await db
      .insert(tasks)
      .values({ workspaceId: s.ws.id, title: "Write the PRD", assigneeId: s.pm.id, status: "DONE", deliverables: [{ id: deliverableId, kind: "prd", title: "PRD Procurement", content: BODY, createdAt: new Date().toISOString() }] })
      .returning();
    const c = await callWithParams(candidates, "GET", at(s.app.id, "/import"), undefined, { id: s.app.id });
    expect(c.json.candidates).toEqual([expect.objectContaining({ taskId: t!.id, deliverableId, title: "PRD Procurement" })]);
    const r = await callWithParams(importPrd, "POST", at(s.app.id, "/import"), { taskId: t!.id, deliverableId }, { id: s.app.id });
    expect(r.json).toEqual({ version: 1 });
    const box = await callWithParams(inbox, "GET", "/api/inbox", undefined, {});
    expect((box.json.items as { kind: string }[]).find((x) => x.kind === "doc_review")).toMatchObject({ docKind: "prd", version: 1, app: { name: "Procurement" } });
    expect((await callWithParams(importPrd, "POST", at(s.app.id, "/import"), { taskId: t!.id, deliverableId: "nope" }, { id: s.app.id })).status).toBe(404);
  });
});
