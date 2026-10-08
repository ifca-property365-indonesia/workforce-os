import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { approvals, db, members, telegramCallbacks, telegramLinkCodes, users, workspaces } from "@wfos/db";
import { hashLinkCode, newCallbackId, setTelegramFetch, signCallback } from "@wfos/shared/telegram";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as startLink } from "@/app/api/me/telegram/route";
import { call, resetBrowser } from "./browser";

const SECRET = "webhook-secret-for-tests-0123456789";
let sent: { method: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  resetBrowser();
  sent = [];
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  setTelegramFetch(async (url, init) => {
    sent.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  });
});
afterEach(() => {
  setTelegramFetch(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

async function hook(update: unknown, secret = SECRET) {
  const res = await webhook(new NextRequest("http://localhost:3010/api/telegram/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) }));
  return res.status;
}

async function fixture(role: "OWNER" | "ADMIN" | "MEMBER" = "ADMIN", chatId: number | null = Math.floor(Math.random() * 1e9)) {
  const email = `tg-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4), telegramChatId: chatId === null ? null : String(chatId) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  const [a] = await db.insert(approvals).values({ workspaceId: ws!.id, toolName: "send_email", title: "Send mail", payload: { to: "x@example.com" } }).returning();
  return { user: u!, ws: ws!, approval: a!, chatId, email };
}

async function button(f: Awaited<ReturnType<typeof fixture>>, action: "approve" | "reject" = "approve", ttlMs = 60_000) {
  const id = newCallbackId();
  await db.insert(telegramCallbacks).values({ id, userId: f.user.id, workspaceId: f.ws.id, approvalId: f.approval.id, action, expiresAt: new Date(Date.now() + ttlMs) });
  return signCallback(id);
}

const press = (data: string, fromId: number) => ({ callback_query: { id: "cq1", from: { id: fromId }, data, message: { chat: { id: fromId }, message_id: 7 } } });
const status = async (id: string) => (await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, id)))[0]!.s;
const lastAnswer = () => sent.filter((s) => s.method === "answerCallbackQuery").at(-1)?.body.text as string | undefined;

describe("Telegram webhook", () => {
  it("rejects requests without the right secret header", async () => {
    expect(await hook({}, "wrong")).toBe(401);
    expect(await hook({}, "")).toBe(401);
    expect(sent).toEqual([]);
  });

  it("links a chat with a one-time code, and the code works once", async () => {
    const f = await fixture("ADMIN", null);
    await call(login, "POST", "/api/auth/login", { email: f.email, password: "pw-123456" });
    const r = await call(startLink, "POST", "/api/me/telegram", undefined);
    expect(r.status).toBe(200);
    const code = r.json.code as string;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    await hook({ message: { chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: `/link ${code}` } });
    expect((await db.select().from(users).where(eq(users.id, f.user.id)))[0]!.telegramChatId).toBe("4242");
    await hook({ message: { chat: { id: 5555, type: "private" }, from: { id: 5555 }, text: `/link ${code}` } });
    expect((await db.select().from(users).where(eq(users.id, f.user.id)))[0]!.telegramChatId).toBe("4242");
  });

  it("ignores link codes sent from group chats and expired codes", async () => {
    const f = await fixture("ADMIN", null);
    const { code, hash } = { code: "ABCDEFGH", hash: hashLinkCode("ABCDEFGH") };
    await db.insert(telegramLinkCodes).values({ codeHash: hash, userId: f.user.id, expiresAt: new Date(Date.now() - 1000) });
    await hook({ message: { chat: { id: 77, type: "private" }, text: `/link ${code}` } });
    await hook({ message: { chat: { id: 78, type: "group" }, text: `/link ${code}` } });
    expect((await db.select().from(users).where(eq(users.id, f.user.id)))[0]!.telegramChatId).toBeNull();
  });

  it("an Admin's button approves once; a second press does nothing", async () => {
    const f = await fixture("ADMIN");
    const data = await button(f);
    await hook(press(data, f.chatId!));
    expect(await status(f.approval.id)).toBe("APPROVED");
    expect(sent.some((s) => s.method === "editMessageText")).toBe(true);
    await hook(press(data, f.chatId!));
    expect(lastAnswer()).toMatch(/already used/);
  });

  it("pressing one button voids the other button of the pair", async () => {
    const f = await fixture("ADMIN");
    const yes = await button(f, "approve");
    const no = await button(f, "reject");
    await hook(press(no, f.chatId!));
    expect(await status(f.approval.id)).toBe("REJECTED");
    await hook(press(yes, f.chatId!));
    expect(lastAnswer()).toMatch(/already used/);
    expect(await status(f.approval.id)).toBe("REJECTED");
  });

  it("a press from another Telegram user is refused and does not burn the button", async () => {
    const f = await fixture("ADMIN");
    const data = await button(f);
    await hook(press(data, 999_999_999_9));
    expect(lastAnswer()).toMatch(/not for you/);
    expect(await status(f.approval.id)).toBe("PENDING");
    await hook(press(data, f.chatId!));
    expect(await status(f.approval.id)).toBe("APPROVED");
  });

  it("refuses a user whose role dropped below Admin", async () => {
    const f = await fixture("MEMBER");
    await hook(press(await button(f), f.chatId!));
    expect(lastAnswer()).toMatch(/role/);
    expect(await status(f.approval.id)).toBe("PENDING");
  });

  it("refuses expired and tampered buttons", async () => {
    const f = await fixture("ADMIN");
    await hook(press(await button(f, "approve", -1000), f.chatId!));
    expect(lastAnswer()).toMatch(/expired/);
    const good = await button(f);
    const [id] = good.split(".");
    const other = newCallbackId();
    await hook(press(`${other}.${good.split(".")[1]}`, f.chatId!));
    expect(lastAnswer()).toMatch(/Invalid/);
    await hook(press(`${id}.AAAAAAAAAAAAAAAAAAAAAA`, f.chatId!));
    expect(lastAnswer()).toMatch(/Invalid/);
    expect(await status(f.approval.id)).toBe("PENDING");
  });
});
