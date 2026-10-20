import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, members, shareLinks, users, workspaces } from "@wfos/db";
import { totp } from "@wfos/shared/totp";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as login2fa } from "@/app/api/auth/login/2fa/route";
import { POST as setup2fa } from "@/app/api/me/2fa/setup/route";
import { POST as enable2fa } from "@/app/api/me/2fa/enable/route";
import { POST as reauth } from "@/app/api/me/reauth/route";
import { GET as me } from "@/app/api/me/route";
import { GET as listLinks, POST as createLink } from "@/app/api/share-links/route";
import { DELETE as revokeLink } from "@/app/api/share-links/[id]/route";
import { GET as openLink } from "@/app/lihat/[token]/route";
import { GET as listTasks, POST as createTask } from "@/app/api/tasks/route";
import { GET as listGoals } from "@/app/api/goals/route";
import { GET as getEmployee } from "@/app/api/employees/[id]/route";
import { GET as listEmployees } from "@/app/api/employees/route";
import { GET as taskSteps } from "@/app/api/tasks/[id]/steps/route";
import { employees } from "@wfos/db";
import { GET as inbox } from "@/app/api/inbox/route";
import { GET as outbox } from "@/app/api/outbox/route";
import { guestAllowed, guestEventAllowed, hashShareToken } from "@/lib/server/share";
import { call, callWithParams, jar, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());
const PASSWORD = "pw-123456-share";

async function owner() {
  const [ws] = await db.insert(workspaces).values({ name: "Kantor", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const email = `o-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "O", passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "OWNER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  const secret = String((await call(setup2fa, "POST", "/api/me/2fa/setup")).json.secret);
  expect((await call(enable2fa, "POST", "/api/me/2fa/enable", { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
  jar.clear();
  await call(login, "POST", "/api/auth/login", { email, password: PASSWORD });
  await call(login2fa, "POST", "/api/auth/login/2fa", { code: totp(secret) });
  const stepUp = async () => expect((await call(reauth, "POST", "/api/me/reauth", { password: PASSWORD, code: totp(secret, Date.now() + 30_000) })).status).toBe(200);
  return { ws: ws!, email, password: PASSWORD, stepUp };
}

describe("view-only links", () => {
  it("only GET on the allow-list; work events only", () => {
    expect(guestAllowed("GET", "/api/tasks")).toBe(true);
    expect(guestAllowed("GET", "/api/apps/abc")).toBe(true);
    expect(guestAllowed("GET", "/api/apps/abc/env")).toBe(false);
    expect(guestAllowed("GET", "/api/apps/abc/test-users")).toBe(false);
    expect(guestAllowed("GET", "/api/approvals")).toBe(false);
    expect(guestAllowed("GET", "/api/share-links")).toBe(false);
    expect(guestAllowed("POST", "/api/tasks")).toBe(false);
    expect(guestEventAllowed("task.updated")).toBe(true);
    expect(guestEventAllowed("chat.delta")).toBe(false);
    expect(guestEventAllowed("approval.created")).toBe(false);
  });

  it("the Owner creates a link with a step-up; a guest opens it, reads the allow-list, changes nothing; revoking ends it", async () => {
    const o = await owner();
    expect((await call(createLink, "POST", "/api/share-links", { label: "Rapat direksi", hours: 24 })).json.code).toBe("step_up_required");
    await o.stepUp();
    expect((await call(createLink, "POST", "/api/share-links", { label: "x", hours: 5 })).status).toBe(400);
    const made = await call(createLink, "POST", "/api/share-links", { label: "Rapat direksi", hours: 24 });
    expect(made.status).toBe(200);
    const token = String(made.json.url).split("/lihat/")[1]!;
    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, made.json.id as string));
    expect(row!.tokenHash).toBe(hashShareToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "share_link.created"), eq(auditLog.workspaceId, o.ws.id)))).toHaveLength(1);

    // a guest (no account) opens it
    const ownerCookies = jar.getAll();
    jar.clear();
    expect((await callWithParams(openLink, "GET", `/lihat/${token}`, undefined, { token })).status).toBe(303);
    expect((await db.select().from(shareLinks).where(eq(shareLinks.id, row!.id)))[0]!.opens).toBe(1);
    const who = await call(me, "GET", "/api/me");
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ role: "VIEWER", guest: { label: "Rapat direksi" }, workspace: { id: o.ws.id } });
    expect((await call(listTasks, "GET", "/api/tasks")).status).toBe(200);
    expect((await call(listGoals, "GET", "/api/goals")).status).toBe(200);
    // employees without their instructions, context or permissions; no step-by-step activity
    const [emp] = await db.insert(employees).values({ workspaceId: o.ws.id, name: "Dewi", role: "Sales", model: "m", instructions: "secret playbook", businessContext: "margins" }).returning();
    const one = await callWithParams(getEmployee, "GET", `/api/employees/${emp!.id}`, undefined, { id: emp!.id });
    expect(one.json.employee).toMatchObject({ name: "Dewi", role: "Sales" });
    expect(JSON.stringify(one.json)).not.toMatch(/secret playbook|margins/);
    expect(JSON.stringify((await call(listEmployees, "GET", "/api/employees")).json)).not.toContain("secret playbook");
    expect((await callWithParams(taskSteps, "GET", `/api/tasks/${emp!.id}/steps`, undefined, { id: emp!.id })).status).toBe(403);
    // closed: pages off the list, any change, the links themselves
    expect((await call(inbox, "GET", "/api/inbox")).json.code).toBe("view_only");
    expect((await call(outbox, "GET", "/api/outbox")).status).toBe(403);
    expect((await call(createTask, "POST", "/api/tasks", { title: "x" })).status).toBe(403);
    expect((await call(listLinks, "GET", "/api/share-links")).status).toBe(403);

    // the Owner revokes it: the guest is out at the next request
    const guestCookies = jar.getAll();
    jar.clear();
    for (const c of ownerCookies) jar.set(c.name, c.value);
    const links = await call(listLinks, "GET", "/api/share-links");
    expect(links.status).toBe(200);
    expect((await callWithParams(revokeLink, "DELETE", `/api/share-links/${row!.id}`, undefined, { id: row!.id })).status).toBe(200);
    jar.clear();
    for (const c of guestCookies) jar.set(c.name, c.value);
    expect((await call(me, "GET", "/api/me")).status).toBe(401);
    expect((await callWithParams(openLink, "GET", `/lihat/${token}`, undefined, { token })).status).toBe(303);
    expect((await call(me, "GET", "/api/me")).status).toBe(401);
  });

  it("an expired link opens nothing", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "W", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    const token = "t".repeat(43);
    await db.insert(shareLinks).values({ workspaceId: ws!.id, tokenHash: hashShareToken(token), label: "old", expiresAt: new Date(Date.now() - 1000) });
    await callWithParams(openLink, "GET", `/lihat/${token}`, undefined, { token });
    expect(jar.getAll()).toEqual([]);
    expect((await call(me, "GET", "/api/me")).status).toBe(401);
  });
});
