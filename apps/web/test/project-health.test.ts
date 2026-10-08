import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { clients, db, employees, members, projects, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listClients } from "@/app/api/clients/route";
import { call, resetBrowser } from "./browser";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => resetBrowser());

describe("client project health API", () => {
  it("reports late / at risk / on track per project in the workspace time zone", async () => {
    const email = `h-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false, timezone: "Asia/Jakarta" }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "MEMBER" });
    const [c] = await db.insert(clients).values({ workspaceId: ws!.id, name: "Acme" }).returning();
    const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "E", role: "R", model: "m" }).returning();
    const [late] = await db.insert(projects).values({ workspaceId: ws!.id, clientId: c!.id, name: "late", deadline: day(-3), progress: 90 }).returning();
    const [soon] = await db.insert(projects).values({ workspaceId: ws!.id, clientId: c!.id, name: "soon", deadline: day(5), progress: 40 }).returning();
    const [ok] = await db.insert(projects).values({ workspaceId: ws!.id, clientId: c!.id, name: "ok", deadline: day(40), progress: 20 }).returning();
    const [idle] = await db.insert(projects).values({ workspaceId: ws!.id, clientId: c!.id, name: "idle", deadline: null, progress: 10 }).returning();
    const [done] = await db.insert(projects).values({ workspaceId: ws!.id, clientId: c!.id, name: "done", deadline: day(-10), status: "done" }).returning();
    // idle: created and last touched 10 days ago; ok: recent task activity
    await db.update(projects).set({ updatedAt: new Date(Date.now() - 10 * 86_400_000), createdAt: new Date(Date.now() - 20 * 86_400_000) }).where(eq(projects.id, idle!.id));
    await db.insert(tasks).values({ workspaceId: ws!.id, assigneeId: emp!.id, projectId: ok!.id, title: "work" });
    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
    const r = await call(listClients, "GET", "/api/clients");
    expect(r.json.timezone).toBe("Asia/Jakarta");
    const ps = (r.json.clients as { projects: { id: string; health: string; reasons: string[] }[] }[])[0]!.projects;
    const health = Object.fromEntries(ps.map((p) => [p.id, p.health]));
    expect(health[late!.id]).toBe("late");
    expect(health[soon!.id]).toBe("at_risk");
    expect(health[ok!.id]).toBe("on_track");
    expect(health[idle!.id]).toBe("at_risk");
    expect(ps.find((p) => p.id === idle!.id)!.reasons).toEqual(["no_activity"]);
    expect(health[done!.id]).toBe("done");
  });
});
