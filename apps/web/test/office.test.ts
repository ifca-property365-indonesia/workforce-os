import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db, employees, members, steps, tasks, teamMembers, teams, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as office } from "@/app/api/office/route";
import { call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  return ws!;
}

describe("office snapshot", () => {
  it("returns this workspace's employees with rooms, current task and last step, nothing else", async () => {
    const ws = await workspace();
    const other = await workspace();
    const email = `o-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "O", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    await db.insert(members).values({ workspaceId: ws.id, userId: u!.id, role: "VIEWER" });
    const [dev, pm, gone] = await db
      .insert(employees)
      .values([
        { workspaceId: ws.id, name: "Dewi", role: "Developer", model: "m", department: "developer" },
        { workspaceId: ws.id, name: "Putu", role: "PM", model: "m" },
        { workspaceId: ws.id, name: "Old", role: "X", model: "m", status: "ARCHIVED" },
      ])
      .returning();
    const [foreign] = await db.insert(employees).values({ workspaceId: other.id, name: "Stranger", role: "X", model: "m" }).returning();
    const [team] = await db.insert(teams).values({ workspaceId: ws.id, name: "Growth" }).returning();
    await db.insert(teamMembers).values({ teamId: team!.id, employeeId: pm!.id });
    const [t] = await db.insert(tasks).values({ workspaceId: ws.id, title: "Fix login", assigneeId: dev!.id, status: "RUNNING" }).returning();
    await db.insert(steps).values([
      { workspaceId: ws.id, taskId: t!.id, employeeId: dev!.id, kind: "llm", name: "llm_call", createdAt: new Date(Date.now() - 5000) },
      { workspaceId: ws.id, taskId: t!.id, employeeId: dev!.id, kind: "tool", name: "Edit", input: { secret: "file contents" }, output: "SECRET OUTPUT", createdAt: new Date() },
    ]);
    await db.insert(tasks).values({ workspaceId: other.id, title: "Their task", assigneeId: foreign!.id, status: "RUNNING" });

    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
    const r = await call(office, "GET", "/api/office");
    expect(r.status).toBe(200);
    const list = r.json.employees as { id: string; name: string; teams: { name: string }[]; task: { title: string } | null; lastStep: { kind: string; name: string } | null }[];
    expect(list.map((e) => e.name).sort()).toEqual(["Dewi", "Putu"]);
    expect(list.some((e) => e.id === gone!.id || e.id === foreign!.id)).toBe(false);
    const d = list.find((e) => e.id === dev!.id)!;
    expect(d.task).toMatchObject({ title: "Fix login", status: "RUNNING" });
    expect(d.lastStep).toMatchObject({ kind: "tool", name: "Edit" });
    expect(list.find((e) => e.id === pm!.id)!.teams).toEqual([{ id: team!.id, name: "Growth" }]);
    const raw = JSON.stringify(r.json);
    expect(raw).not.toContain("SECRET OUTPUT");
    expect(raw).not.toContain("file contents");
    expect(raw).not.toContain("Their task");
    expect((r.json.departments as Record<string, string>).developer).toBeTruthy();
  });
});
