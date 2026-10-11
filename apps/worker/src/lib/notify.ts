import { and, eq } from "drizzle-orm";
import { db, members, notificationPrefs, notifications } from "@wfos/db";
import type { NotificationChannel, NotifyJob } from "@wfos/shared";
import { sendMail } from "@wfos/shared/mail";
import { withRetry } from "@wfos/shared/server";
import { env } from "./env";
import { getSmtp, getWebhookUrl, getWorkspace } from "./settings";
import { msg } from "@wfos/shared/messages";
import { log } from "./logger";
import { telegramNotify } from "./telegram";
import { pushNotify } from "./push";

export type NotifyInput = Omit<NotifyJob, "kind">;

/**
 * The members a personal channel (Telegram, push) reaches for this notification: every member of the workspace
 * (or only `userId` when it targets one), minus those whose preferences switch this kind off on that channel and
 * those who muted the employee it is about. A notification without a kind reaches everyone (no preference applies).
 */
export async function channelRecipients(workspaceId: string, channel: NotificationChannel, n: Pick<NotifyInput, "notificationKind" | "employeeId" | "userId">): Promise<string[]> {
  const rows = await db
    .select({ userId: members.userId, channels: notificationPrefs.channels, muted: notificationPrefs.mutedEmployeeIds })
    .from(members)
    .leftJoin(notificationPrefs, and(eq(notificationPrefs.userId, members.userId), eq(notificationPrefs.workspaceId, members.workspaceId)))
    .where(and(eq(members.workspaceId, workspaceId), ...(n.userId ? [eq(members.userId, n.userId)] : [])));
  return rows
    .filter((r) => !(n.notificationKind && r.channels?.[n.notificationKind]?.[channel] === false))
    .filter((r) => !(n.employeeId && r.muted?.includes(n.employeeId)))
    .map((r) => r.userId);
}

/**
 * channelRecipients, or — when the preference lookup fails — a fallback that keeps approvals reachable: for kind
 * "approval" every member (the one targeted, when `userId` is set: undefined = every linked member / device, so the
 * Admins still get their Approve / Reject buttons); for any other kind nobody on this channel (null). Never throws.
 */
export async function recipientsOrFallback(
  workspaceId: string,
  channel: NotificationChannel,
  n: Pick<NotifyInput, "notificationKind" | "employeeId" | "userId">,
  lookup: typeof channelRecipients = channelRecipients,
): Promise<string[] | undefined | null> {
  try {
    return await lookup(workspaceId, channel, n);
  } catch (e) {
    const fallback = n.notificationKind === "approval";
    log.warn({ err: e, workspaceId, channel, kind: n.notificationKind ?? null, fallback }, "notify: notification preferences lookup failed");
    if (!fallback) return null;
    return n.userId ? [n.userId] : undefined;
  }
}

/**
 * In-app notification + email to the workspace notify address + optional webhook (WhatsApp/Telegram gateway)
 * + Telegram to linked members (with approval buttons for Admins when `approvalId` is set) + Web Push to subscribed devices.
 * The in-app row is stored with its kind / employee / recipient (workspace-wide unless `userId` is set; the web
 * filters what each member sees by their preferences). Telegram and push go only to the members whose
 * preferences allow this kind on that channel and who have not muted the employee (see channelRecipients).
 * Email and the webhook are workspace-level and unchanged.
 */
export async function notify(n: NotifyInput): Promise<void> {
  const { workspaceId, subject, text, link, approvalId } = n;
  await db.insert(notifications).values({
    workspaceId,
    userId: n.userId ?? null,
    employeeId: n.employeeId ?? null,
    kind: n.notificationKind ?? "info",
    title: subject,
    body: text,
    link: link ?? null,
  });
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
    const to = await recipientsOrFallback(workspaceId, "telegram", n);
    if (to === undefined || to?.length) await telegramNotify(workspaceId, subject, text, link, approvalId, to);
  } catch (e) {
    log.warn({ err: e }, "notify telegram failed");
  }
  try {
    const to = await recipientsOrFallback(workspaceId, "push", n);
    if (to === undefined || to?.length) await pushNotify(workspaceId, subject, text, link, to);
  } catch (e) {
    log.warn({ err: e }, "notify push failed");
  }
}
