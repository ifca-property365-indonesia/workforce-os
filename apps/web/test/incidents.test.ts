import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, employees, incidents, members, tasks, users, workspaces } from "@wfos/db";
import type { IncidentStatus } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listIncidents } from "@/app/api/incidents/route";
import { call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [worker] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const [lead] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Budi", role: "Lead", model: "m" }).returning();
  const [task] = await db.insert(tasks).values({ workspaceId: ws!.id, title: "Monthly report", assigneeId: worker!.id }).returning();
  return { ws: ws!, worker: worker!, lead: lead!, task: task! };
}

async function signedIn(role: "VIEWER" | "ADMIN" = "VIEWER") {
  const a = await workspace();
  const b = await workspace();
  const email = `i-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "V", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: a.ws.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { a, b };
}

type Ws = Awaited<ReturnType<typeof workspace>>;
async function incident(w: Ws, status: IncidentStatus, extra: Partial<typeof incidents.$inferInsert> = {}) {
  const [row] = await db
    .insert(incidents)
    .values({ workspaceId: w.ws.id, kind: "failed", status, taskId: w.task.id, employeeId: w.worker.id, summary: `${status} one`, ...extra })
    .returning();
  return row!;
}

type Row = { id: string; status: string; kind: string; task: { id: string; title: string } | null; employee: { name: string } | null; handler: { name: string } | null };

describe("GET /api/incidents", () => {
  it("lists only this workspace's unresolved incidents by default, newest first, with names joined", async () => {
    const { a, b } = await signedIn();
    const old = await incident(a, "open", { createdAt: new Date(Date.now() - 3600_000) });
    const handling = await incident(a, "handling", { kind: "stalled", handlerEmployeeId: a.lead.id });
    const escalated = await incident(a, "escalated", { kind: "loop" });
    const muted = await incident(a, "muted");
    await incident(a, "resolved", { resolvedAt: new Date() });
    await incident(b, "open");
    const r = await call(listIncidents, "GET", "/api/incidents");
    expect(r.status).toBe(200);
    const rows = r.json.incidents as Row[];
    expect(rows.map((x) => x.id).sort()).toEqual([old.id, handling.id, escalated.id, muted.id].sort());
    expect(rows.at(-1)!.id).toBe(old.id);
    const h = rows.find((x) => x.id === handling.id)!;
    expect(h).toMatchObject({ kind: "stalled", status: "handling", task: { id: a.task.id, title: "Monthly report" }, employee: { name: "Sari" }, handler: { name: "Budi" } });
    expect(rows.find((x) => x.id === escalated.id)!.handler).toBeNull();
  });

  it("filters by ?status and ignores unknown statuses", async () => {
    const { a } = await signedIn();
    const open = await incident(a, "open");
    const resolved = await incident(a, "resolved", { resolvedAt: new Date() });
    await incident(a, "handling");
    const one = await call(listIncidents, "GET", "/api/incidents?status=resolved");
    expect((one.json.incidents as Row[]).map((x) => x.id)).toEqual([resolved.id]);
    const two = await call(listIncidents, "GET", "/api/incidents?status=open,bogus");
    expect((two.json.incidents as Row[]).map((x) => x.id)).toEqual([open.id]);
    const junk = await call(listIncidents, "GET", "/api/incidents?status=bogus");
    expect((junk.json.incidents as Row[]).map((x) => x.status).sort()).toEqual(["handling", "open"]);
  });

  it("counts incidents resolved in the last 7 days (this workspace only)", async () => {
    const { a, b } = await signedIn();
    await incident(a, "resolved", { resolvedAt: new Date(Date.now() - 2 * 86400_000) });
    await incident(a, "resolved", { resolvedAt: new Date(Date.now() - 6 * 86400_000) });
    await incident(a, "resolved", { resolvedAt: new Date(Date.now() - 9 * 86400_000) });
    await incident(b, "resolved", { resolvedAt: new Date() });
    const r = await call(listIncidents, "GET", "/api/incidents");
    expect(r.json.resolved7d).toBe(2);
  });

  it("never joins another workspace's task or employee", async () => {
    const { a, b } = await signedIn();
    // a malformed row pointing at foreign ids must not leak their titles or names
    await incident(a, "open", { taskId: b.task.id, employeeId: b.worker.id, handlerEmployeeId: b.lead.id });
    const rows = (await call(listIncidents, "GET", "/api/incidents")).json.incidents as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: null, employee: null, handler: null });
  });

  it("returns at most 50 rows", async () => {
    const { a } = await signedIn();
    await db.insert(incidents).values(Array.from({ length: 55 }, () => ({ workspaceId: a.ws.id, kind: "failed" as const, status: "open" as const })));
    const r = await call(listIncidents, "GET", "/api/incidents?limit=500");
    expect((r.json.incidents as Row[]).length).toBe(50);
  });

  it("floors and clamps ?limit to 1–50; junk falls back to 50", async () => {
    const { a } = await signedIn();
    await db.insert(incidents).values(Array.from({ length: 55 }, () => ({ workspaceId: a.ws.id, kind: "failed" as const, status: "open" as const })));
    const n = async (q: string) => ((await call(listIncidents, "GET", `/api/incidents${q}`)).json.incidents as Row[]).length;
    expect(await n("?limit=3")).toBe(3);
    expect(await n("?limit=2.9")).toBe(2);
    expect(await n("?limit=0.5")).toBe(1);
    expect(await n("?limit=0")).toBe(1);
    expect(await n("?limit=-7")).toBe(1);
    expect(await n("?limit=abc")).toBe(50);
    expect(await n("?limit=")).toBe(50);
    expect(await n("?limit=Infinity")).toBe(50);
  });

  it("requires a session", async () => {
    const r = await call(listIncidents, "GET", "/api/incidents");
    expect(r.status).toBe(401);
  });
});
