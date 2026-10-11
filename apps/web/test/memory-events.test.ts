import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, employees, memories, memoryEvents, members, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listMemories, POST as addMemory } from "@/app/api/employees/[id]/memories/route";
import { GET as listEvents } from "@/app/api/employees/[id]/memory-events/route";
import { DELETE as deleteMemory, PATCH as patchMemory } from "@/app/api/memories/[id]/route";
import { POST as undo } from "@/app/api/memory-events/[id]/undo/route";
import { memoryPatch } from "@/lib/memory-edit";
import { call, callWithParams, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function setup(role: "VIEWER" | "MEMBER" = "MEMBER") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const email = `me-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "Dewi", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { ws: ws!, emp: emp!, user: u! };
}

const events = (employeeId: string) => db.select().from(memoryEvents).where(eq(memoryEvents.employeeId, employeeId)).orderBy(asc(memoryEvents.createdAt));
const memory = async (id: string) => (await db.select().from(memories).where(eq(memories.id, id)))[0];
const undoEvent = (id: string, force = false) => callWithParams(undo, "POST", `/api/memory-events/${id}/undo${force ? "?force=1" : ""}`, undefined, { id });

describe("memory journal from the web", () => {
  it("journals create / update / delete with the user as actor and keeps the untrusted mark", async () => {
    const { ws, emp, user } = await setup();
    const add = await callWithParams(addMemory, "POST", `/api/employees/${emp.id}/memories`, { content: "Kopi Nusantara prefers English" }, { id: emp.id });
    expect(add.status).toBe(200);
    const id = add.json.id as string;
    await db.update(memories).set({ untrusted: true }).where(eq(memories.id, id));
    const expires = "2030-01-31T23:59:59.000Z";
    const p = await callWithParams(patchMemory, "PATCH", `/api/memories/${id}`, { content: "Kopi Nusantara prefers Indonesian", expiresAt: expires }, { id });
    expect(p.status).toBe(200);
    const row = await memory(id);
    expect(row).toMatchObject({ content: "Kopi Nusantara prefers Indonesian", untrusted: true });
    expect(row!.expiresAt?.toISOString()).toBe(expires);
    expect((await callWithParams(deleteMemory, "DELETE", `/api/memories/${id}`, undefined, { id })).status).toBe(200);
    expect(await memory(id)).toBeUndefined();

    const ev = await events(emp.id);
    expect(ev.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    for (const e of ev) expect(e).toMatchObject({ actor: "user", actorUserId: user.id, workspaceId: ws.id, memoryId: id });
    expect(ev[0]!.before).toBeNull();
    expect(ev[1]!.before).toMatchObject({ content: "Kopi Nusantara prefers English", untrusted: true, expiresAt: null });
    expect(ev[1]!.after).toMatchObject({ content: "Kopi Nusantara prefers Indonesian", untrusted: true, expiresAt: expires });
    expect(ev[2]!.before).toMatchObject({ content: "Kopi Nusantara prefers Indonesian", untrusted: true });
    expect(ev[2]!.after).toBeNull();
  });

  it("lists memories with their state (expired / superseded)", async () => {
    const { ws, emp } = await setup();
    const [a] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "new fact" }).returning();
    await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "old fact", supersededBy: a!.id });
    await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "stale fact", expiresAt: new Date(Date.now() - 1000) });
    const r = await callWithParams(listMemories, "GET", `/api/employees/${emp.id}/memories`, undefined, { id: emp.id });
    const states = Object.fromEntries((r.json.memories as { content: string; state: string }[]).map((m) => [m.content, m.state]));
    expect(states).toEqual({ "new fact": "active", "old fact": "superseded", "stale fact": "expired" });
  });

  it("undo of an update restores the previous text; undoing that restore brings the edit back", async () => {
    const { ws, emp } = await setup();
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "first", source: "agent", untrusted: true }).returning();
    await callWithParams(patchMemory, "PATCH", `/api/memories/${m!.id}`, { content: "second" }, { id: m!.id });
    const [upd] = await events(emp.id);
    const u1 = await undoEvent(upd!.id);
    expect(u1.status).toBe(200);
    expect(await memory(m!.id)).toMatchObject({ content: "first", untrusted: true, source: "agent" });
    const after1 = await events(emp.id);
    expect(after1.map((e) => e.action)).toEqual(["update", "restore"]);
    expect(after1[0]!.undoneAt).not.toBeNull();
    expect(after1[1]).toMatchObject({ actor: "user", before: { content: "second" }, after: { content: "first" } });

    // the same entry cannot be undone twice
    expect((await undoEvent(upd!.id)).status).toBe(409);

    // undoing the undo
    expect((await undoEvent(after1[1]!.id)).status).toBe(200);
    expect((await memory(m!.id))!.content).toBe("second");
    expect((await events(emp.id)).map((e) => e.action)).toEqual(["update", "restore", "restore"]);
  });

  it("undo of a delete recreates the memory with the same id, kind, source, untrusted mark and expiry", async () => {
    const { ws, emp } = await setup();
    const expiresAt = new Date("2031-05-01T00:00:00Z");
    const createdAt = new Date("2025-01-01T00:00:00Z");
    const [m] = await db
      .insert(memories)
      .values({ workspaceId: ws.id, employeeId: emp.id, content: "deleted fact", kind: "preference", source: "import", untrusted: true, expiresAt, createdAt })
      .returning();
    await callWithParams(deleteMemory, "DELETE", `/api/memories/${m!.id}`, undefined, { id: m!.id });
    const [del] = await events(emp.id);
    const r = await undoEvent(del!.id);
    expect(r.status).toBe(200);
    expect(r.json.memoryId).toBe(m!.id);
    const back = await memory(m!.id);
    expect(back).toMatchObject({ id: m!.id, content: "deleted fact", kind: "preference", source: "import", untrusted: true, workspaceId: ws.id, employeeId: emp.id });
    expect(back!.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(back!.createdAt.toISOString()).toBe(createdAt.toISOString());
    // undoing the restore deletes it again
    const restore = (await events(emp.id)).find((e) => e.action === "restore")!;
    expect(restore.before).toBeNull();
    expect((await undoEvent(restore.id)).status).toBe(200);
    expect(await memory(m!.id)).toBeUndefined();
  });

  it("undo of a create removes the memory; worker-written events (actor agent / tidy) can be undone too", async () => {
    const { ws, emp } = await setup();
    const add = await callWithParams(addMemory, "POST", `/api/employees/${emp.id}/memories`, { content: "temporary" }, { id: emp.id });
    const [create] = await events(emp.id);
    expect((await undoEvent(create!.id)).status).toBe(200);
    expect(await memory(add.json.id as string)).toBeUndefined();

    // a nightly tidy expired a memory: undo puts the expiry back to what it was
    // (the worker's snapshot has no source: the row keeps its own)
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "kept", source: "rejection", untrusted: true, expiresAt: new Date(Date.now() - 1000) }).returning();
    const [tidy] = await db
      .insert(memoryEvents)
      .values({ workspaceId: ws.id, employeeId: emp.id, memoryId: m!.id, action: "expire", actor: "tidy", before: { kind: "fact", content: "kept", untrusted: true, expiresAt: null, supersededBy: null }, after: { content: "kept" } })
      .returning();
    expect((await undoEvent(tidy!.id)).status).toBe(200);
    expect(await memory(m!.id)).toMatchObject({ expiresAt: null, source: "rejection", untrusted: true });
  });

  it("History lists events newest first with the actor's name and pages with ?before", async () => {
    const { ws, emp } = await setup();
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "v0" }).returning();
    for (let i = 1; i <= 3; i++) await callWithParams(patchMemory, "PATCH", `/api/memories/${m!.id}`, { content: `v${i}` }, { id: m!.id });
    const first = await callWithParams(listEvents, "GET", `/api/employees/${emp.id}/memory-events?limit=2`, undefined, { id: emp.id });
    expect(first.status).toBe(200);
    const page1 = first.json.events as { id: string; after: { content: string }; actorName: string }[];
    expect(page1.map((e) => e.after.content)).toEqual(["v3", "v2"]);
    expect(page1[0]!.actorName).toBe("Dewi");
    const next = await callWithParams(listEvents, "GET", `/api/employees/${emp.id}/memory-events?limit=2&before=${first.json.nextCursor}`, undefined, { id: emp.id });
    expect((next.json.events as { after: { content: string } }[]).map((e) => e.after.content)).toEqual(["v1"]);
    expect(next.json.nextCursor).toBeNull();
  });

  it("needs MEMBER, and never reaches another workspace's journal", async () => {
    const { ws, emp } = await setup("VIEWER");
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "x1" }).returning();
    const [ev] = await db.insert(memoryEvents).values({ workspaceId: ws.id, employeeId: emp.id, memoryId: m!.id, action: "update", actor: "agent", before: { content: "x0" }, after: { content: "x1" } }).returning();
    expect((await undoEvent(ev!.id)).status).toBe(403);
    expect((await callWithParams(listEvents, "GET", `/api/employees/${emp.id}/memory-events`, undefined, { id: emp.id })).status).toBe(403);
    expect((await callWithParams(patchMemory, "PATCH", `/api/memories/${m!.id}`, { content: "nope" }, { id: m!.id })).status).toBe(403);

    resetBrowser();
    await setup("MEMBER"); // a member of a different workspace
    expect((await undoEvent(ev!.id)).status).toBe(404);
    expect((await callWithParams(listEvents, "GET", `/api/employees/${emp.id}/memory-events`, undefined, { id: emp.id })).status).toBe(404);
    expect((await memory(m!.id))!.content).toBe("x1");
  });

  it("refuses to undo over a later change (409 memory_changed_since) unless forced", async () => {
    const { ws, emp } = await setup();
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "v1" }).returning();
    await callWithParams(patchMemory, "PATCH", `/api/memories/${m!.id}`, { content: "v2" }, { id: m!.id });
    await callWithParams(patchMemory, "PATCH", `/api/memories/${m!.id}`, { content: "v3" }, { id: m!.id });
    const [first] = await events(emp.id);
    const r = await undoEvent(first!.id);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("memory_changed_since");
    expect((await memory(m!.id))!.content).toBe("v3");
    expect((await events(emp.id)).every((e) => !e.undoneAt)).toBe(true);
    // only expiry / superseded-by changing counts too
    const [n] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "n1" }).returning();
    await callWithParams(patchMemory, "PATCH", `/api/memories/${n!.id}`, { content: "n2" }, { id: n!.id });
    await db.update(memories).set({ expiresAt: new Date("2032-01-01T00:00:00Z") }).where(eq(memories.id, n!.id));
    const nEv = (await events(emp.id)).find((e) => e.memoryId === n!.id)!;
    expect((await undoEvent(nEv.id)).json.code).toBe("memory_changed_since");

    const forced = await undoEvent(first!.id, true);
    expect(forced.status).toBe(200);
    expect((await memory(m!.id))!.content).toBe("v1");
    // a delete undone after the memory was recreated under the same id, or a create undone after it was deleted
    const add = await callWithParams(addMemory, "POST", `/api/employees/${emp.id}/memories`, { content: "short-lived" }, { id: emp.id });
    const created = (await events(emp.id)).find((e) => e.action === "create" && e.memoryId === add.json.id)!;
    await db.delete(memories).where(eq(memories.id, add.json.id as string));
    expect((await undoEvent(created.id)).json.code).toBe("memory_changed_since");
  });

  it("restoring a memory whose expiry has passed brings it back without one, and says so", async () => {
    const { ws, emp } = await setup();
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "old news", expiresAt: new Date(Date.now() - 86400_000) }).returning();
    await callWithParams(deleteMemory, "DELETE", `/api/memories/${m!.id}`, undefined, { id: m!.id });
    const [del] = await events(emp.id);
    const r = await undoEvent(del!.id);
    expect(r.status).toBe(200);
    expect(r.json.expiryCleared).toBe(true);
    expect((await memory(m!.id))!.expiresAt).toBeNull();
    // a future expiry is kept as it was
    const future = new Date(Date.now() + 30 * 86400_000);
    const [k] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "still valid", expiresAt: future }).returning();
    await callWithParams(deleteMemory, "DELETE", `/api/memories/${k!.id}`, undefined, { id: k!.id });
    const kDel = (await events(emp.id)).find((e) => e.memoryId === k!.id)!;
    const rk = await undoEvent(kDel.id);
    expect(rk.json.expiryCleared).toBe(false);
    expect((await memory(k!.id))!.expiresAt?.toISOString()).toBe(future.toISOString());
  });

  it("a restored row keeps its own source over the snapshot's", async () => {
    const { ws, emp } = await setup();
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "after", source: "import" }).returning();
    const [ev] = await db
      .insert(memoryEvents)
      .values({ workspaceId: ws.id, employeeId: emp.id, memoryId: m!.id, action: "update", actor: "agent", before: { content: "before", kind: "fact", source: "agent" }, after: { content: "after" } })
      .returning();
    expect((await undoEvent(ev!.id)).status).toBe(200);
    expect(await memory(m!.id)).toMatchObject({ content: "before", source: "import" });
  });
});

describe("memory edit body", () => {
  it("sends the expiry only when the date input changed", () => {
    expect(memoryPatch({ content: "x", expires: "2030-01-31", expiresWas: "2030-01-31" })).toEqual({ content: "x" });
    expect(memoryPatch({ content: "x", expires: "", expiresWas: "" })).toEqual({ content: "x" });
    expect(memoryPatch({ content: "x", expires: "", expiresWas: "2030-01-31" })).toEqual({ content: "x", expiresAt: null });
    const set = memoryPatch({ content: "x", expires: "2030-02-01", expiresWas: "" });
    expect(set.expiresAt).toBe(new Date("2030-02-01T23:59:59").toISOString());
  });
});
