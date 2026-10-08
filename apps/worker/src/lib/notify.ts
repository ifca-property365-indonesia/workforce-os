import { db, notifications } from "@wfos/db";
import { sendMail } from "@wfos/shared/mail";
import { withRetry } from "@wfos/shared/server";
import { env } from "./env";
import { getSmtp, getWebhookUrl, getWorkspace } from "./settings";
import { msg } from "@wfos/shared/messages";
import { log } from "./logger";
import { telegramNotify } from "./telegram";
import { pushNotify } from "./push";

/**
 * In-app notification + email to the workspace notify address + optional webhook (WhatsApp/Telegram gateway)
 * + Telegram to linked members (with approval buttons for Admins when `approvalId` is set) + Web Push to subscribed devices.
 */
export async function notify(workspaceId: string, subject: string, text: string, link?: string, approvalId?: string): Promise<void> {
  await db.insert(notifications).values({ workspaceId, kind: "info", title: subject, body: text, link: link ?? null });
  if (subject.startsWith("[Demo]")) return; // demo makes no network calls
  const ws = await getWorkspace(workspaceId);
  const url = link ? `${env.appUrl}${link}` : env.appUrl;
  const smtp = await getSmtp(workspaceId);
  if (smtp && ws.notifyEmail) {
    try {
      await sendMail(smtp, { to: [ws.notifyEmail], subject: `[Workforce OS] ${subject}`, text: `${text}\n\n${msg(ws.defaultLocale, "notify.open", { url })}` });
    } catch (e) {
      log.warn({ err: e }, "notify email failed");
    }
  }
  const hook = await getWebhookUrl(workspaceId);
  if (hook) {
    try {
      await withRetry(
        async (signal) => {
          const r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${subject}*\n${text}\n${url}` }), signal });
          if (r.status >= 500) throw new Error(`webhook ${r.status}`);
        },
        { retries: 2, timeoutMs: 10000, label: "notify-webhook" },
      );
    } catch (e) {
      log.warn({ err: e }, "notify webhook failed");
    }
  }
  try {
    await telegramNotify(workspaceId, subject, text, link, approvalId);
  } catch (e) {
    log.warn({ err: e }, "notify telegram failed");
  }
  try {
    await pushNotify(workspaceId, subject, text, link);
  } catch (e) {
    log.warn({ err: e }, "notify push failed");
  }
}
