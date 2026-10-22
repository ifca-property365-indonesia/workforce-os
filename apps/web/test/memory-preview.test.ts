import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, employees, memories, members, users, workspaces } from "@wfos/db";
import { memoryPreviewKey } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as previewGet, POST as previewPost } from "@/app/api/employees/[id]/memory-preview/route";
import { GET as byIds } from "@/app/api/memories/route";
import { serverEnv } from "@/lib/server/env";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

beforeEach(() => {
  resetBrowser();
  vi.mocked(queueModule.q.misc).mockClear();
});

async function signedIn() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `m-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "A", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "MEMBER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  return { ws: ws!, emp: emp! };
}

describe("memory preview and used memories", () => {
  it("asks the worker for a preview and returns it once it is there", async () => {
    const { ws, emp } = await signedIn();
    const r = await callWithParams(previewPost, "POST", `/api/employees/${emp.id}/memory-preview`, { brief: "kirim invoice" }, { id: emp.id });
    expect(r.status).toBe(200);
    const requestId = r.json.requestId as string;
    expect(queueModule.q.misc).toHaveBeenCalledWith({ kind: "memory_preview", workspaceId: ws.id, employeeId: emp.id, brief: "kirim invoice", clientId: null, requestId });
    const url = `/api/employees/${emp.id}/memory-preview?request=${requestId}`;
    expect((await callWithParams(previewGet, "GET", url, undefined, { id: emp.id })).json).toEqual({ ready: false, memories: [] });
    await queueModule.redis().set(memoryPreviewKey(serverEnv.namespace, requestId), JSON.stringify([{ id: "x", kind: "fact", content: "c", untrusted: false }]));
    expect((await callWithParams(previewGet, "GET", url, undefined, { id: emp.id })).json).toMatchObject({ ready: true, memories: [{ content: "c" }] });

    const other = await db.insert(employees).values({ workspaceId: (await db.insert(workspaces).values({ name: "B", slug: `b-${randomUUID().slice(0, 8)}` }).returning())[0]!.id, name: "X", role: "r", model: "m" }).returning();
    expect((await callWithParams(previewPost, "POST", `/api/employees/${other[0]!.id}/memory-preview`, { brief: "x y" }, { id: other[0]!.id })).status).toBe(404);
  });

  it("lists memories by id from this workspace only", async () => {
    const { ws, emp } = await signedIn();
    const [mine] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, content: "Klien suka ringkas" }).returning();
    const [wsB] = await db.insert(workspaces).values({ name: "B", slug: `b-${randomUUID().slice(0, 8)}` }).returning();
    const [empB] = await db.insert(employees).values({ workspaceId: wsB!.id, name: "Y", role: "r", model: "m" }).returning();
    const [theirs] = await db.insert(memories).values({ workspaceId: wsB!.id, employeeId: empB!.id, content: "rahasia B" }).returning();
    const r = await call(byIds, "GET", `/api/memories?ids=${mine!.id},${theirs!.id},not-a-uuid`);
    expect((r.json.memories as { id: string }[]).map((m) => m.id)).toEqual([mine!.id]);
  });
});
