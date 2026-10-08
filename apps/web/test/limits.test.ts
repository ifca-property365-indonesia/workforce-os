import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { claudeLimits, db, employees, members, setClaudeCredential, tasks, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as limits } from "@/app/api/limits/route";
import { POST as resume } from "@/app/api/limits/resume/route";
import { queueModule } from "./browser";
import { call, resetBrowser } from "./browser";

async function signedIn(role: "OWNER" | "ADMIN" | "MEMBER", credential: "oauth" | "api_key") {
  const email = `l-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  await setClaudeCredential(ws!.id, credential, credential === "oauth" ? "sk-ant-oat01-web-limits-000000000" : "sk-ant-api03-web-limits-0000000000");
  await db.insert(claudeLimits).values([
    { workspaceId: ws!.id, credentialSource: "workspace", rateLimitType: "seven_day", status: "allowed", utilization: 0.3, resetsAt: new Date(Date.now() + 86_400_000) },
    { workspaceId: ws!.id, credentialSource: "workspace", rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.8, resetsAt: new Date(Date.now() + 3_600_000) },
  ]);
  await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  return ws!;
}

beforeEach(() => resetBrowser());

describe("subscription limit API", () => {
  it("shows the windows (5-hour first) for a subscription credential", async () => {
    await signedIn("MEMBER", "oauth");
    const r = await call(limits, "GET", "/api/limits");
    expect(r.json.subscription).toBe(true);
    expect((r.json.windows as { type: string; utilization: number }[]).map((w) => [w.type, w.utilization])).toEqual([
      ["five_hour", 0.8],
      ["seven_day", 0.3],
    ]);
    expect(typeof r.json.usdThisMonth).toBe("number");
  });

  it("hides the subscription meter for API-key workspaces", async () => {
    await signedIn("MEMBER", "api_key");
    const r = await call(limits, "GET", "/api/limits");
    expect(r.json.subscription).toBe(false);
    expect(r.json.windows).toEqual([]);
  });

  it("reports the pause and lets an admin resume held tasks by hand", async () => {
    const ws = await signedIn("ADMIN", "oauth");
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "E", role: "R", model: "m" }).returning();
    const until = new Date(Date.now() + 3_600_000);
    await db.update(workspaces).set({ quotaPausedUntil: until, quotaPauseReason: "The 5-hour limit was reached." }).where(eq(workspaces.id, ws.id));
    const [held] = await db.insert(tasks).values({ workspaceId: ws.id, assigneeId: emp!.id, title: "held", status: "QUEUED", error: "Paused: The 5-hour limit was reached." }).returning();
    const [other] = await db.insert(tasks).values({ workspaceId: ws.id, assigneeId: emp!.id, title: "other", status: "QUEUED", error: null }).returning();
    const before = await call(limits, "GET", "/api/limits");
    expect(before.json.paused).toEqual({ until: until.toISOString(), reason: "The 5-hour limit was reached." });
    queueModule.q.task.mockClear();
    const r = await call(resume, "POST", "/api/limits/resume");
    expect(r.json.resumed).toBe(1);
    expect(queueModule.q.task).toHaveBeenCalledWith(held!.id, ws.id);
    expect(queueModule.q.task).not.toHaveBeenCalledWith(other!.id, ws.id);
    expect((await call(limits, "GET", "/api/limits")).json.paused).toBeNull();
  });

  it("only admins can resume", async () => {
    await signedIn("MEMBER", "oauth");
    expect((await call(resume, "POST", "/api/limits/resume")).status).toBe(403);
  });
});
