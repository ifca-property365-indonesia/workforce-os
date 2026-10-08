import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, members, telegramCallbacks, users } from "@wfos/db";
import { setTelegramFetch, verifyCallback } from "@wfos/shared/telegram";
import { telegramDailySummary, telegramNotify } from "../src/lib/telegram";
import { makeApproval, makeEmployee, makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

interface Sent {
  method: string;
  body: { chat_id: number; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
}
let sent: Sent[] = [];

beforeEach(() => {
  resetTransport();
  sent = [];
  process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  setTelegramFetch(async (url, init) => {
    sent.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  });
});
afterEach(() => {
  setTelegramFetch(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

async function member(workspaceId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", chatId: string | null, locale: "en" | "id" | null = null) {
  const [u] = await db.insert(users).values({ email: `n-${randomUUID().slice(0, 8)}@test.local`, name: "N", passwordHash: "x", telegramChatId: chatId, locale }).returning();
  await db.insert(members).values({ workspaceId, userId: u!.id, role });
  return u!;
}

const chat = () => String(Math.floor(Math.random() * 1e9));

describe("Telegram notifications", () => {
  it("sends approval buttons only to linked Admins and Owners; others get the text", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const a = await makeApproval(ws.id, null, emp.id);
    const owner = await member(ws.id, "OWNER", chat());
    const admin = await member(ws.id, "ADMIN", chat(), "id");
    const mem = await member(ws.id, "MEMBER", chat());
    await member(ws.id, "ADMIN", null); // not linked: nothing sent
    const n = await telegramNotify(ws.id, "Approval needed", "body", `/approvals?focus=${a.id}`, a.id);
    expect(n).toBe(3);
    const to = (u: { telegramChatId: string | null }) => sent.find((s) => String(s.body.chat_id) === u.telegramChatId)!;
    expect(to(mem).body.reply_markup).toBeUndefined();
    for (const u of [owner, admin]) {
      const kb = to(u).body.reply_markup!.inline_keyboard[0]!;
      expect(kb).toHaveLength(2);
      for (const b of kb) {
        const id = verifyCallback(b.callback_data);
        expect(id).not.toBeNull();
        expect(b.callback_data.length).toBeLessThanOrEqual(64);
        const [row] = await db.select().from(telegramCallbacks).where(eq(telegramCallbacks.id, id!));
        expect(row).toMatchObject({ userId: u.id, approvalId: a.id, workspaceId: ws.id, usedAt: null });
      }
    }
    expect(to(admin).body.reply_markup!.inline_keyboard[0]![0]!.text).toContain("Setujui");
    expect(to(owner).body.reply_markup!.inline_keyboard[0]![0]!.text).toContain("Approve");
  });

  it("plain notifications carry no buttons and create no rows", async () => {
    const ws = await makeWorkspace();
    const admin = await member(ws.id, "ADMIN", chat());
    await telegramNotify(ws.id, "Task finished", "done", "/tasks/x");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.reply_markup).toBeUndefined();
    expect(await db.select().from(telegramCallbacks).where(eq(telegramCallbacks.userId, admin.id))).toEqual([]);
  });

  it("sends nothing when the bot is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const ws = await makeWorkspace();
    await member(ws.id, "ADMIN", chat());
    expect(await telegramNotify(ws.id, "s", "t")).toBe(0);
    expect(sent).toEqual([]);
  });

  it("daily summary goes out once per workspace per day, at the configured hour only", async () => {
    const ws = await makeWorkspace();
    const u = await member(ws.id, "ADMIN", chat());
    const at = (iso: string) => new Date(iso);
    // 08:30 Asia/Jakarta = 01:30 UTC
    expect(await telegramDailySummary(at("2026-10-08T05:30:00Z"))).toBe(0);
    await telegramDailySummary(at("2026-10-08T01:30:00Z"));
    await telegramDailySummary(at("2026-10-08T01:40:00Z"));
    const mine = sent.filter((s) => String(s.body.chat_id) === u.telegramChatId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body.text).toMatch(/Daily summary/);
  });
});
