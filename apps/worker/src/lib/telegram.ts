import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { approvals, db, members, tasks, telegramCallbacks, users } from "@wfos/db";
import { hasRole, resolveLocale } from "@wfos/shared";
import { msg } from "@wfos/shared/messages";
import { newCallbackId, signCallback, telegramCall, telegramConfigured } from "@wfos/shared/telegram";
import { todayIn } from "@wfos/shared/health";
import { env } from "./env";
import { log } from "./logger";
import { redis } from "./redis";
import { getWorkspace } from "./settings";

const BUTTON_TTL_MS = 24 * 3_600_000;
const TZ = process.env.APP_TIME_ZONE || "Asia/Jakarta";
const SUMMARY_HOUR = Number(process.env.TELEGRAM_SUMMARY_HOUR ?? 8);

async function linkedMembers(workspaceId: string) {
  return db
    .select({ userId: users.id, chatId: users.telegramChatId, locale: users.locale, role: members.role })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.workspaceId, workspaceId), isNotNull(users.telegramChatId)));
}

/**
 * Sends a notification to every linked member of the workspace. For an approval, Admins and Owners also get
 * Approve/Reject buttons: each button is a single-use row bound to that user and that approval, and its
 * callback_data is HMAC-signed. Members below Admin get the text only.
 */
export async function telegramNotify(workspaceId: string, subject: string, text: string, link?: string, approvalId?: string): Promise<number> {
  if (!telegramConfigured()) return 0;
  const ws = await getWorkspace(workspaceId);
  const url = link ? `${env.appUrl}${link}` : env.appUrl;
  let sent = 0;
  for (const m of await linkedMembers(workspaceId)) {
    const locale = resolveLocale(m.locale, ws.defaultLocale, null);
    const payload: Record<string, unknown> = { chat_id: Number(m.chatId), text: `${subject}\n\n${text}\n\n${msg(locale, "notify.open", { url })}`, disable_web_page_preview: true };
    if (approvalId && hasRole(m.role, "ADMIN")) {
      const expiresAt = new Date(Date.now() + BUTTON_TTL_MS);
      const ids = { approve: newCallbackId(), reject: newCallbackId() };
      await db.insert(telegramCallbacks).values([
        { id: ids.approve, userId: m.userId, workspaceId, approvalId, action: "approve", expiresAt },
        { id: ids.reject, userId: m.userId, workspaceId, approvalId, action: "reject", expiresAt },
      ]);
      payload.reply_markup = {
        inline_keyboard: [
          [
            { text: msg(locale, "telegram.approve"), callback_data: signCallback(ids.approve) },
            { text: msg(locale, "telegram.reject"), callback_data: signCallback(ids.reject) },
          ],
        ],
      };
    }
    try {
      await telegramCall("sendMessage", payload);
      sent++;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "telegram send failed");
    }
  }
  return sent;
}

/** Daily summary at TELEGRAM_SUMMARY_HOUR (APP_TIME_ZONE), once per workspace per day. */
export async function telegramDailySummary(now = new Date()): Promise<number> {
  if (!telegramConfigured()) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour !== SUMMARY_HOUR) return 0;
  const day = todayIn(TZ, now);
  const wsIds = await db
    .selectDistinct({ id: members.workspaceId })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(isNotNull(users.telegramChatId));
  let n = 0;
  for (const { id } of wsIds) {
    const claimed = await redis.set(`${env.namespace}:tg-summary:${id}:${day}`, "1", "EX", 2 * 86_400, "NX");
    if (!claimed) continue;
    const since = new Date(now.getTime() - 86_400_000);
    const counts = await db
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, id), gte(tasks.updatedAt, since), inArray(tasks.status, ["DONE", "FAILED"])))
      .groupBy(tasks.status);
    const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(and(eq(approvals.workspaceId, id), eq(approvals.status, "PENDING")));
    const done = counts.find((c) => c.status === "DONE")?.n ?? 0;
    const failed = counts.find((c) => c.status === "FAILED")?.n ?? 0;
    const ws = await getWorkspace(id);
    for (const m of await linkedMembers(id)) {
      const locale = resolveLocale(m.locale, ws.defaultLocale, null);
      try {
        await telegramCall("sendMessage", { chat_id: Number(m.chatId), text: msg(locale, "telegram.summary", { workspace: ws.name, done, failed, pending: pending?.n ?? 0, url: `${env.appUrl}/dashboard` }) });
        n++;
      } catch (e) {
        log.warn({ err: (e as Error).message }, "telegram summary failed");
      }
    }
  }
  return n;
}
