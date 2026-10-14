import { randomUUID } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { clients, db, documents, members, projects, teams, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as createClient } from "@/app/api/clients/route";
import { GET as getClient, PATCH as patchClient } from "@/app/api/clients/[id]/route";
import { POST as createProject } from "@/app/api/projects/route";
import { PATCH as patchProject } from "@/app/api/projects/[id]/route";
import { GET as listDocuments, POST as uploadDocuments } from "@/app/api/documents/route";
import { handoffPick, handoffTarget } from "@/lib/handoff";
import { call, callWithParams, resetBrowser } from "./browser";

// uploads land in a throwaway folder, not the repo's storage/ (set before the app's env module loads)
const storage = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/wfos-web-kb-`);
  process.env.STORAGE_DIR = dir;
  return dir;
});

beforeEach(() => resetBrowser());

async function signedIn(role: "ADMIN" | "MEMBER" = "MEMBER") {
  const mk = async () => (await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning())[0]!;
  const ws = await mk();
  const other = await mk();
  const email = `c-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { ws, other };
}

describe("client codes", () => {
  it("a code is unique per workspace: 409 on create and on edit, free in another workspace", async () => {
    const { ws, other } = await signedIn();
    const gob = await call(createClient, "POST", "/api/clients", { name: "PT Grand Outlet Bali", code: "GOB", website: "siravillage.com", industry: "Retail" });
    expect(gob.status).toBe(200);
    expect(gob.json.client).toMatchObject({ code: "GOB", website: "siravillage.com", industry: "Retail" });

    const dup = await call(createClient, "POST", "/api/clients", { name: "Another", code: "GOB" });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ code: "client_code_taken", clientCode: "GOB" });
    expect(String(dup.json.error)).toContain("GOB");

    const btid = await call(createClient, "POST", "/api/clients", { name: "PT Bali Turtle Island Development", code: "BTID" });
    const id = (btid.json.client as { id: string }).id;
    const clash = await callWithParams(patchClient, "PATCH", `/api/clients/${id}`, { code: "GOB" }, { id });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("client_code_taken");
    // saving its own code again is not a clash; clearing it is allowed for any number of clients
    expect((await callWithParams(patchClient, "PATCH", `/api/clients/${id}`, { code: "BTID", industry: "Property" }, { id })).status).toBe(200);
    expect((await call(createClient, "POST", "/api/clients", { name: "No code A" })).status).toBe(200);
    expect((await call(createClient, "POST", "/api/clients", { name: "No code B", code: "" })).status).toBe(200);
    // a lower-case or one-letter code is refused by the schema
    expect((await call(createClient, "POST", "/api/clients", { name: "Bad", code: "gob" })).status).toBe(400);

    // another workspace may use the same code
    await db.insert(clients).values({ workspaceId: other.id, name: "Theirs", code: "GOB" });
    expect((await db.select().from(clients).where(eq(clients.workspaceId, ws.id))).filter((c) => c.code === "GOB")).toHaveLength(1);
  });
});

describe("project status", () => {
  it("stamps statusUpdatedAt when health, next milestone or next step changes, and not otherwise", async () => {
    const { ws, other } = await signedIn();
    const [division] = await db.insert(teams).values({ workspaceId: ws.id, name: "Delivery", key: "delivery" }).returning();
    const [foreign] = await db.insert(teams).values({ workspaceId: other.id, name: "Theirs" }).returning();
    const c = await call(createClient, "POST", "/api/clients", { name: "GOB", code: "GOB" });
    const clientId = (c.json.client as { id: string }).id;

    const plain = await call(createProject, "POST", "/api/projects", { clientId, name: "Portal" });
    expect((plain.json.project as { statusUpdatedAt: string | null }).statusUpdatedAt).toBeNull();

    const refused = await call(createProject, "POST", "/api/projects", { clientId, name: "X", teamId: foreign!.id });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("unknown_team");

    const r = await call(createProject, "POST", "/api/projects", { clientId, name: "Guest check-in", teamId: division!.id, startDate: "2026-10-01", nextMilestone: "Preview", health: "on_track" });
    expect(r.status).toBe(200);
    const p = r.json.project as { id: string; statusUpdatedAt: string | null; teamId: string };
    expect(p.teamId).toBe(division!.id);
    const first = p.statusUpdatedAt;
    expect(first).not.toBeNull();

    // progress is not a status change
    await new Promise((res) => setTimeout(res, 15));
    await callWithParams(patchProject, "PATCH", `/api/projects/${p.id}`, { progress: 40 }, { id: p.id });
    const [afterProgress] = await db.select().from(projects).where(eq(projects.id, p.id));
    expect(afterProgress!.statusUpdatedAt!.toISOString()).toBe(new Date(first!).toISOString());

    // the same value again is not a change either
    await callWithParams(patchProject, "PATCH", `/api/projects/${p.id}`, { nextMilestone: "Preview" }, { id: p.id });
    expect((await db.select().from(projects).where(eq(projects.id, p.id)))[0]!.statusUpdatedAt!.toISOString()).toBe(new Date(first!).toISOString());

    for (const change of [{ health: "at_risk" }, { nextMilestone: "Live on 1 Nov" }, { nextStep: "QA on the preview" }]) {
      const [before] = await db.select().from(projects).where(eq(projects.id, p.id));
      await new Promise((res) => setTimeout(res, 15));
      const u = await callWithParams(patchProject, "PATCH", `/api/projects/${p.id}`, change, { id: p.id });
      expect(u.status).toBe(200);
      const [after] = await db.select().from(projects).where(eq(projects.id, p.id));
      expect(after!.statusUpdatedAt!.getTime()).toBeGreaterThan(before!.statusUpdatedAt!.getTime());
    }

    // the client page shows the team's status as the project's health when it is the more serious one
    const page = await callWithParams(getClient, "GET", `/api/clients/${clientId}`, undefined, { id: clientId });
    const shown = (page.json.projects as { id: string; health: string; statusHealth: string; reasons: string[] }[]).find((x) => x.id === p.id)!;
    expect(shown).toMatchObject({ health: "at_risk", statusHealth: "at_risk" });
    expect(shown.reasons).toContain("reported");
    expect(page.json.running).toEqual([]);
  });
});

describe("knowledge per client", () => {
  async function upload(fields: Record<string, string>) {
    const form = new FormData();
    form.append("files", new File(["Opening hours: 10:00-22:00"], "faq.md", { type: "text/markdown" }));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const req = new NextRequest("http://localhost:3010/api/documents", { method: "POST", body: form, headers: { "x-real-ip": "203.0.113.7" } });
    const res = await uploadDocuments(req, { params: Promise.resolve({}) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("stores the client on an upload, lists and filters by it, and refuses another workspace's client", async () => {
    const { ws, other } = await signedIn();
    const c = await call(createClient, "POST", "/api/clients", { name: "PT Grand Outlet Bali", code: "GOB" });
    const clientId = (c.json.client as { id: string }).id;
    const [foreign] = await db.insert(clients).values({ workspaceId: other.id, name: "Theirs" }).returning();

    const mine = await upload({ clientId });
    expect(mine.status).toBe(200);
    const docId = (mine.json.documents as { id: string }[])[0]!.id;
    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row).toMatchObject({ workspaceId: ws.id, clientId });
    expect(row!.storagePath.startsWith(path.join(storage, "uploads", ws.id) + path.sep)).toBe(true);

    expect((await upload({})).status).toBe(200);
    const refused = await upload({ clientId: foreign!.id });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("unknown_client");
    expect((await upload({ clientId: "not-a-uuid" })).status).toBe(400);

    const all = await call(listDocuments, "GET", "/api/documents");
    expect((all.json.documents as unknown[]).length).toBe(2);
    const forClient = await call(listDocuments, "GET", `/api/documents?clientId=${clientId}`);
    expect(forClient.json.documents).toMatchObject([{ id: docId, clientId, clientCode: "GOB", clientName: "PT Grand Outlet Bali" }]);
    const general = await call(listDocuments, "GET", "/api/documents?clientId=general");
    expect((general.json.documents as { clientId: string | null }[]).map((d) => d.clientId)).toEqual([null]);
  });
});

describe("PRD handoff preview", () => {
  it("names the target division; a payload made before divisions still shows its developer", () => {
    const now = { prdDeliverableId: "d", title: "x", prd: "p", teamId: "t1", teamName: "Delivery", repositoryId: null, clientId: null, projectId: null, untrustedInput: false, resumeTaskId: null };
    expect(handoffTarget(now)).toEqual({ kind: "division", name: "Delivery" });
    expect(handoffPick(now)).toEqual({ teamId: "t1", repositoryId: null });
    const old = { title: "x", prd: "p", developerId: "e1", developerName: "Dony", repositoryId: "r1" };
    expect(handoffTarget(old)).toEqual({ kind: "developer", name: "Dony" });
    // Edit & Approve of an old payload keeps the developer and can choose a division
    expect(handoffPick(old)).toEqual({ developerId: "e1", repositoryId: "r1" });
    expect(handoffTarget({ teamId: null, teamName: null })).toEqual({ kind: "none" });
  });
});
