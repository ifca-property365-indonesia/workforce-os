import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, employees, members, notificationPrefs, notificationReads, notifications, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as list, POST as markRead } from "@/app/api/notifications/route";
import { GET as getPrefs, PUT as putPrefs } from "@/app/api/me/notification-prefs/route";
import { call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [sari] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
  const [budi] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Budi", role: "Sales", model: "m" }).returning();
  return { ws: ws!, sari: sari!, budi: budi! };
}

async function user(workspaceId: string) {
  const email = `n-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "N", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role: "VIEWER" });
  return { ...u!, email };
}

async function as(u: { email: string }) {
  resetBrowser();
  expect((await call(login, "POST", "/api/auth/login", { email: u.email, password: "pw-123456" })).status).toBe(200);
}

async function notify(workspaceId: string, v: Partial<typeof notifications.$inferInsert> = {}) {
  const [n] = await db.insert(notifications).values({ workspaceId, kind: "task_done", title: v.title ?? "t", ...v }).returning();
  return n!;
}

type Row = { id: string; title: string; read: boolean };
const titles = async () => ((await call(list, "GET", "/api/notifications")).json.notifications as Row[]).map((r) => r.title).sort();

describe("GET /api/notifications", () => {
  it("shows broadcasts and my own notifications, never someone else's or another workspace's", async () => {
    const { ws } = await workspace();
    const other = await workspace();
    const me = await user(ws.id);
    const colleague = await user(ws.id);
    await notify(ws.id, { title: "everyone" });
    await notify(ws.id, { title: "mine", userId: me.id });
    await notify(ws.id, { title: "theirs", userId: colleague.id });
    await notify(other.ws.id, { title: "elsewhere" });
    await as(me);
    expect(await titles()).toEqual(["everyone", "mine"]);
    await as(colleague);
    expect(await titles()).toEqual(["everyone", "theirs"]);
  });

  it("keeps read state per user: marking all read does not touch a colleague's bell", async () => {
    const { ws } = await workspace();
    const me = await user(ws.id);
    const colleague = await user(ws.id);
    await notify(ws.id, { title: "a" });
    await notify(ws.id, { title: "b", userId: me.id });
    await notify(ws.id, { title: "c", userId: colleague.id });
    await as(me);
    let r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(2);
    expect((r.json.notifications as Row[]).every((n) => !n.read)).toBe(true);
    expect((await call(markRead, "POST", "/api/notifications")).status).toBe(200);
    r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(0);
    expect((r.json.notifications as Row[]).every((n) => n.read)).toBe(true);
    // idempotent
    expect((await call(markRead, "POST", "/api/notifications")).status).toBe(200);
    const reads = await db.select().from(notificationReads).where(eq(notificationReads.userId, me.id));
    expect(reads).toHaveLength(2);

    await as(colleague);
    r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(2);
    // a new broadcast is unread again for me only
    await notify(ws.id, { title: "d" });
    await as(me);
    r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(1);
    expect((r.json.notifications as Row[]).find((n) => n.title === "d")!.read).toBe(false);
  });

  it("leaves out kinds I switched off in-app and employees I muted", async () => {
    const { ws, sari, budi } = await workspace();
    const me = await user(ws.id);
    await notify(ws.id, { title: "approval", kind: "approval" });
    await notify(ws.id, { title: "done by sari", kind: "task_done", employeeId: sari.id });
    await notify(ws.id, { title: "done by budi", kind: "task_done", employeeId: budi.id });
    await notify(ws.id, { title: "limits", kind: "limits" });
    await as(me);
    const put = await call(putPrefs, "PUT", "/api/me/notification-prefs", {
      channels: { approval: { inapp: false, email: true }, limits: { email: false } },
      mutedEmployeeIds: [sari.id],
    });
    expect(put.status).toBe(200);
    expect(await titles()).toEqual(["done by budi", "limits"]);
    // muted ones are not counted as unread either, and mark-all leaves them alone
    expect((await call(list, "GET", "/api/notifications")).json.unread).toBe(2);
    await call(markRead, "POST", "/api/notifications");
    expect(await db.select().from(notificationReads).where(eq(notificationReads.userId, me.id))).toHaveLength(2);
  });
});

describe("GET /api/notifications (legacy reads and the unread window)", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);

  it("a notification read before per-user reads existed (notifications.read_at) is read for every member", async () => {
    const { ws } = await workspace();
    const me = await user(ws.id);
    const colleague = await user(ws.id);
    await notify(ws.id, { title: "legacy read", readAt: new Date() });
    await notify(ws.id, { title: "fresh" });
    for (const u of [me, colleague]) {
      await as(u);
      const r = await call(list, "GET", "/api/notifications");
      expect(r.json.unread).toBe(1);
      const rows = r.json.notifications as Row[];
      expect(rows.find((n) => n.title === "legacy read")!.read).toBe(true);
      expect(rows.find((n) => n.title === "fresh")!.read).toBe(false);
    }
    // mark-all writes a read row only for what was unread
    await call(markRead, "POST", "/api/notifications");
    const reads = await db.select().from(notificationReads).where(eq(notificationReads.userId, colleague.id));
    expect(reads).toHaveLength(1);
  });

  it("counts as unread only what came after I joined and within 90 days; mark-all leaves older rows alone", async () => {
    const { ws } = await workspace();
    const me = await user(ws.id);
    await db.update(members).set({ createdAt: daysAgo(10) }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, me.id)));
    await notify(ws.id, { title: "before I joined", createdAt: daysAgo(20) });
    await notify(ws.id, { title: "after I joined", createdAt: daysAgo(5) });
    await notify(ws.id, { title: "mine, ancient", userId: me.id, createdAt: daysAgo(200) });
    await as(me);
    let r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(1);
    const read = Object.fromEntries((r.json.notifications as Row[]).map((n) => [n.title, n.read]));
    expect(read).toEqual({ "before I joined": true, "after I joined": false, "mine, ancient": true });
    await call(markRead, "POST", "/api/notifications");
    r = await call(list, "GET", "/api/notifications");
    expect(r.json.unread).toBe(0);
    const reads = await db.select({ id: notificationReads.notificationId }).from(notificationReads).where(eq(notificationReads.userId, me.id));
    expect(reads).toHaveLength(1);

    // a long-standing member: the 90-day window still applies
    const veteran = await user(ws.id);
    await db.update(members).set({ createdAt: daysAgo(400) }).where(and(eq(members.workspaceId, ws.id), eq(members.userId, veteran.id)));
    await notify(ws.id, { title: "last year", createdAt: daysAgo(120) });
    await as(veteran);
    r = await call(list, "GET", "/api/notifications");
    // "before I joined" (20 days) and "after I joined" (5 days) are inside the window; "last year" is not
    expect(r.json.unread).toBe(2);
  });
});

describe("/api/me/notification-prefs", () => {
  it("defaults every kind × channel to on except email for the chatty kinds, stores only what differs, and round-trips", async () => {
    const { ws, sari } = await workspace();
    const me = await user(ws.id);
    await as(me);
    const g = await call(getPrefs, "GET", "/api/me/notification-prefs");
    expect(g.status).toBe(200);
    const channels = g.json.channels as Record<string, Record<string, boolean>>;
    expect(Object.keys(channels).sort()).toEqual([...(g.json.kinds as string[])].sort());
    const off = Object.entries(channels).flatMap(([k, c]) => Object.entries(c).filter(([, v]) => !v).map(([ch]) => `${k}.${ch}`));
    expect(off.sort()).toEqual(["chat_reply.email", "task_done.email"]);
    expect(g.json.mutedEmployeeIds).toEqual([]);

    const put = await call(putPrefs, "PUT", "/api/me/notification-prefs", {
      channels: { task_done: { push: false, email: true }, approval: { email: true } },
      mutedEmployeeIds: [sari.id, sari.id],
    });
    expect(put.status).toBe(200);
    const [row] = await db.select().from(notificationPrefs).where(and(eq(notificationPrefs.userId, me.id), eq(notificationPrefs.workspaceId, ws.id)));
    // approval.email is on by default anyway: not stored; task_done.email is off by default: stored as on
    expect(row!.channels).toEqual({ task_done: { push: false, email: true } });
    expect(row!.mutedEmployeeIds).toEqual([sari.id]);
    const again = await call(getPrefs, "GET", "/api/me/notification-prefs");
    expect((again.json.channels as Record<string, Record<string, boolean>>).task_done).toEqual({ inapp: true, email: true, telegram: true, push: false });
    expect(again.json.mutedEmployeeIds).toEqual([sari.id]);
  });

  it("validates kinds, channels, values and employee ids", async () => {
    const { ws } = await workspace();
    const other = await workspace();
    const me = await user(ws.id);
    await as(me);
    const put = (b: unknown) => call(putPrefs, "PUT", "/api/me/notification-prefs", b);
    expect((await put({ channels: { bogus_kind: { inapp: false } }, mutedEmployeeIds: [] })).status).toBe(400);
    expect((await put({ channels: { approval: { sms: false } }, mutedEmployeeIds: [] })).status).toBe(400);
    expect((await put({ channels: { approval: { inapp: "no" } }, mutedEmployeeIds: [] })).status).toBe(400);
    expect((await put({ channels: {}, mutedEmployeeIds: ["not-a-uuid"] })).status).toBe(400);
    expect((await put({ channels: {} })).status).toBe(400);
    expect((await put({ channels: {}, mutedEmployeeIds: [], extra: 1 })).status).toBe(400);
    const foreign = await put({ channels: {}, mutedEmployeeIds: [other.sari.id] });
    expect(foreign.status).toBe(400);
    expect(foreign.json.code).toBe("unknown_employee");
    expect(await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, me.id))).toHaveLength(0);
  });

  it("requires a session", async () => {
    expect((await call(getPrefs, "GET", "/api/me/notification-prefs")).status).toBe(401);
    expect((await call(putPrefs, "PUT", "/api/me/notification-prefs", { channels: {}, mutedEmployeeIds: [] })).status).toBe(401);
  });
});
