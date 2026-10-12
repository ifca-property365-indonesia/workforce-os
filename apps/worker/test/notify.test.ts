import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, members, notificationPrefs, notifications, pushSubscriptions, users, workspaces } from "@wfos/db";
import type { NotificationChannelPrefs, NotifyJob } from "@wfos/shared";
import { setTelegramFetch } from "@wfos/shared/telegram";
import { channelRecipients, notify, recipientsOrFallback } from "../src/lib/notify";
import { setPushSender } from "../src/lib/push";
import { notifyFinished } from "../src/runner/task-status";
import { makeEmployee, makeTask, makeWorkspace } from "./fixtures";
import { resetTransport, transport } from "./transport";

let telegramTo: number[] = [];
let pushTo: string[] = [];

beforeEach(() => {
  resetTransport();
  telegramTo = [];
  pushTo = [];
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  process.env.VAPID_PUBLIC_KEY = "BPub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  setTelegramFetch(async (_url, init) => {
    telegramTo.push((JSON.parse(init.body) as { chat_id: number }).chat_id);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  setPushSender(async (target) => {
    pushTo.push(target.endpoint);
    return { statusCode: 201 };
  });
});
afterEach(() => {
  setTelegramFetch(null);
  setPushSender(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

/** A member linked to Telegram and subscribed to push, with optional notification preferences. */
async function member(workspaceId: string, prefs?: { channels?: NotificationChannelPrefs; muted?: string[] }) {
  const chatId = String(Math.floor(Math.random() * 1e9));
  const [u] = await db.insert(users).values({ email: `n-${randomUUID().slice(0, 8)}@test.local`, name: "N", passwordHash: "x", telegramChatId: chatId }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role: "MEMBER" });
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await db.insert(pushSubscriptions).values({ userId: u!.id, endpoint, p256dh: "k", auth: "a" });
  if (prefs) await db.insert(notificationPrefs).values({ userId: u!.id, workspaceId, channels: prefs.channels ?? {}, mutedEmployeeIds: prefs.muted ?? [] });
  return { user: u!, chatId: Number(chatId), endpoint };
}

const job = (workspaceId: string, over: Partial<NotifyJob> = {}) => ({ workspaceId, subject: "Approval needed: Email", text: "Sari wants to send an email", link: "/approvals", ...over });

describe("per-user notifications", () => {
  it("a member who switched Telegram off for approvals gets no Telegram for them; everyone else (and other kinds) still do", async () => {
    const ws = await makeWorkspace();
    const quiet = await member(ws.id, { channels: { approval: { telegram: false } } });
    const loud = await member(ws.id);

    await notify(job(ws.id, { notificationKind: "approval" }));
    expect(telegramTo).toEqual([loud.chatId]);
    // push is a different channel: both still get it
    expect(pushTo.sort()).toEqual([quiet.endpoint, loud.endpoint].sort());

    telegramTo = [];
    await notify(job(ws.id, { notificationKind: "task_done", subject: "Task finished" }));
    expect(telegramTo.sort()).toEqual([quiet.chatId, loud.chatId].sort());
  });

  it("a member who muted the employee gets no push about it", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const muting = await member(ws.id, { muted: [emp.id] });
    const other = await member(ws.id);

    await notify(job(ws.id, { notificationKind: "incident", employeeId: emp.id }));
    expect(pushTo).toEqual([other.endpoint]);
    expect(telegramTo).toEqual([other.chatId]);

    pushTo = [];
    await notify(job(ws.id, { notificationKind: "incident", employeeId: null }));
    expect(pushTo.sort()).toEqual([muting.endpoint, other.endpoint].sort());
  });

  it("stores kind, employee and recipient on the in-app row (workspace-wide unless it targets one user)", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const one = await member(ws.id);
    await member(ws.id);

    await notify(job(ws.id, { notificationKind: "approval", employeeId: emp.id }));
    await notify(job(ws.id, { notificationKind: "chat_reply", userId: one.user.id, subject: "Sari replied" }));
    await notify(job(ws.id, { subject: "Legacy" }));

    const rows = await db.select().from(notifications).where(eq(notifications.workspaceId, ws.id));
    const by = (title: string) => rows.find((r) => r.title === title)!;
    expect(by("Approval needed: Email")).toMatchObject({ kind: "approval", employeeId: emp.id, userId: null });
    expect(by("Sari replied")).toMatchObject({ kind: "chat_reply", userId: one.user.id });
    expect(by("Legacy")).toMatchObject({ kind: "info", userId: null, employeeId: null });
    // the targeted one reached only its user
    expect(telegramTo.filter((c) => c === one.chatId)).toHaveLength(3);
    expect(telegramTo).toHaveLength(5);
  });

  it("task_done is only queued when the task has a result or deliverables; failures map to task_failed", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const queued = () => transport.queued.filter((q) => q.name === "notify").map((q) => q.data as NotifyJob);

    await notifyFinished(await makeTask(ws.id, emp.id, { result: "   " }), "DONE", "   ");
    expect(queued()).toHaveLength(0);

    const withFile = await makeTask(ws.id, emp.id, { deliverables: [{ id: "d1", kind: "document", title: "Report", content: "…", createdAt: new Date().toISOString() }] });
    await notifyFinished(withFile, "DONE", "");
    await notifyFinished(await makeTask(ws.id, emp.id), "DONE", "All done");
    await notifyFinished(await makeTask(ws.id, emp.id), "FAILED", "boom");
    expect(queued().map((q) => [q.notificationKind, q.employeeId])).toEqual([
      ["task_done", emp.id],
      ["task_done", emp.id],
      ["task_failed", emp.id],
    ]);
  });

  it("emails each member at their login address (one mail each), plus the shared notify address, without duplicates", async () => {
    const ws = await makeWorkspace();
    const a = await member(ws.id);
    const b = await member(ws.id);
    const quiet = await member(ws.id, { channels: { approval: { email: false } } });
    // the shared address is also a member's address (different case): still one mail
    await db.update(workspaces).set({ notifyEmail: a.user.email.toUpperCase() }).where(eq(workspaces.id, ws.id));

    await notify(job(ws.id, { notificationKind: "approval" }));
    const to = transport.mails.map((m) => m.mail.to);
    expect(to.every((t) => t.length === 1)).toBe(true);
    expect(to.flat().sort()).toEqual([a.user.email, b.user.email].sort());
    expect(to.flat()).not.toContain(quiet.user.email);
  });

  it("email is off by default for chatty kinds; the shared address still gets everything; a targeted one reaches only its user", async () => {
    const ws = await makeWorkspace({ notifyEmail: "ops@test.local" });
    const a = await member(ws.id);
    const keen = await member(ws.id, { channels: { task_done: { email: true } } });

    await notify(job(ws.id, { notificationKind: "task_done", subject: "Task finished" }));
    expect(transport.mails.map((m) => m.mail.to[0]).sort()).toEqual(["ops@test.local", keen.user.email].sort());

    transport.mails.length = 0;
    await notify(job(ws.id, { notificationKind: "approval", userId: a.user.id }));
    expect(transport.mails.map((m) => m.mail.to[0]).sort()).toEqual(["ops@test.local", a.user.email].sort());
  });

  it("when the preference lookup fails, approvals still reach every member (Admins keep their buttons); other kinds are skipped", async () => {
    const ws = await makeWorkspace();
    const a = await member(ws.id, { channels: { approval: { telegram: false } } });
    const b = await member(ws.id);
    const broken: typeof channelRecipients = async () => {
      throw new Error("relation \"notification_prefs\" does not exist");
    };
    // undefined = no narrowing: every linked member / device
    expect(await recipientsOrFallback(ws.id, "telegram", { notificationKind: "approval" }, broken)).toBeUndefined();
    expect(await recipientsOrFallback(ws.id, "push", { notificationKind: "approval", userId: a.user.id }, broken)).toEqual([a.user.id]);
    expect(await recipientsOrFallback(ws.id, "telegram", { notificationKind: "task_done" }, broken)).toBeNull();
    expect(await recipientsOrFallback(ws.id, "push", {}, broken)).toBeNull();
    // the lookup working: its answer as is (preferences applied)
    expect(await recipientsOrFallback(ws.id, "telegram", { notificationKind: "approval" })).toEqual([b.user.id]);
  });
});
