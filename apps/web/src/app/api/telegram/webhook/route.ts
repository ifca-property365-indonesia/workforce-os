import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { approvals, audit, db, members, telegramCallbacks, telegramLinkCodes, users } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { hashLinkCode, telegramCall, verifyCallback } from "@wfos/shared/telegram";
import { HttpError } from "@/lib/server/auth";
import { decideApproval } from "@/lib/server/approvals";
import { logger } from "@/lib/server/logger";

interface Update {
  message?: { chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number } };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const reply = (chatId: number, text: string) => telegramCall("sendMessage", { chat_id: chatId, text });

/**
 * Telegram webhook. Only Telegram knows the secret header (set with setWebhook). Messages link a chat with a
 * one-time code; button presses decide approvals. A button works once, only for the user it was sent to, and
 * only while that user still has the Admin role in the approval's workspace.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!secret || !sameSecret(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let u: Update;
  try {
    u = (await req.json()) as Update;
  } catch {
    return NextResponse.json({ ok: true });
  }
  try {
    if (u.message?.text && u.message.chat.type === "private") await onMessage(u.message.chat.id, u.message.text.trim());
    if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "telegram update failed");
  }
  // always 200: Telegram retries anything else
  return NextResponse.json({ ok: true });
}

async function onMessage(chatId: number, text: string) {
  const m = /^\/(?:start|link)\s+([A-Za-z0-9]{8})$/.exec(text);
  if (!m) {
    await reply(chatId, "Workforce OS: open Account → Telegram in the app, then send /link CODE here. · Buka Akun → Telegram di aplikasi, lalu kirim /link KODE di sini.");
    return;
  }
  const [row] = await db
    .delete(telegramLinkCodes)
    .where(and(eq(telegramLinkCodes.codeHash, hashLinkCode(m[1]!)), gt(telegramLinkCodes.expiresAt, new Date())))
    .returning();
  if (!row) {
    await reply(chatId, "That code is invalid or expired. · Kode tidak valid atau kedaluwarsa.");
    return;
  }
  // a chat belongs to one user at a time
  await db.update(users).set({ telegramChatId: null }).where(eq(users.telegramChatId, String(chatId)));
  await db.update(users).set({ telegramChatId: String(chatId) }).where(eq(users.id, row.userId));
  const ms = await db.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.userId, row.userId));
  for (const x of ms) await audit({ workspaceId: x.workspaceId, actorUserId: row.userId, actorLabel: "telegram", action: "user.telegram_linked", targetType: "user", targetId: row.userId });
  await reply(chatId, "Linked. You will get notifications and approval buttons here. · Tertaut. Notifikasi dan tombol persetujuan akan muncul di sini.");
}

async function onCallback(cb: NonNullable<Update["callback_query"]>) {
  const answer = (text: string) => telegramCall("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: true });
  const id = cb.data ? verifyCallback(cb.data) : null;
  if (!id) return answer("Invalid button. · Tombol tidak valid.");
  const used = () => answer("This button was already used or has expired. · Tombol sudah dipakai atau kedaluwarsa.");
  const live = and(eq(telegramCallbacks.id, id), isNull(telegramCallbacks.usedAt), gt(telegramCallbacks.expiresAt, new Date()));
  const [btn] = await db.select().from(telegramCallbacks).where(live);
  if (!btn) return used();
  const [user] = await db.select().from(users).where(eq(users.id, btn.userId));
  // bound to the linked user: the press must come from the chat the button was sent to
  if (!user?.telegramChatId || user.telegramChatId !== String(cb.from.id)) return answer("This button is not for you. · Tombol ini bukan untuk Anda.");
  const [m] = await db.select({ role: members.role }).from(members).where(and(eq(members.userId, user.id), eq(members.workspaceId, btn.workspaceId)));
  if (!m || !hasRole(m.role, "ADMIN")) return answer("Your role does not allow approvals. · Peran Anda tidak mengizinkan persetujuan.");
  // single use: claim atomically (checked after the identity, so a stranger's press cannot burn a valid button)
  const claimed = await db.update(telegramCallbacks).set({ usedAt: new Date() }).where(live).returning({ id: telegramCallbacks.id });
  if (!claimed.length) return used();
  const [a] = await db.select({ title: approvals.title }).from(approvals).where(eq(approvals.id, btn.approvalId));
  try {
    await decideApproval({ userId: user.id, email: user.email, workspaceId: btn.workspaceId, via: "telegram" }, btn.approvalId, { decision: btn.action });
  } catch (e) {
    return answer(e instanceof HttpError ? e.message : "Could not decide. · Gagal memutuskan.");
  }
  const done = btn.action === "approve" ? "✅ Approved · Disetujui" : "❌ Rejected · Ditolak";
  // the other button of the pair is now useless
  await db.update(telegramCallbacks).set({ usedAt: new Date() }).where(and(eq(telegramCallbacks.approvalId, btn.approvalId), isNull(telegramCallbacks.usedAt)));
  if (cb.message) await telegramCall("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `${a?.title ?? ""}\n${done}` });
  return answer(done);
}
