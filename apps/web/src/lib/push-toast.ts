/**
 * Pushes that reach an open window. The service worker asks every visible window over a MessageChannel and only
 * leaves out the system notification when one of them answers `{ ack: true }` within its timeout — so a window
 * that is merely visible (not focused), or an old tab without this listener, never swallows a notification.
 *
 * The same event often arrives twice in a focused window: as a realtime `approval.created` (toasted by the app
 * shell) and as a push. Both name what they are about by key — the push's tag, the approval in its link
 * (`/approvals?focus=<id>`), the chat in its link (`/chat?c=<id>`) — and share one toast id, so the second one
 * replaces the first instead of stacking a duplicate.
 */

export interface PushMessage {
  type: "push";
  title?: unknown;
  body?: unknown;
  url?: unknown;
  tag?: unknown;
}

export const isPushMessage = (d: unknown): d is PushMessage => !!d && typeof d === "object" && (d as { type?: unknown }).type === "push";

/** A same-origin path, never another site (`//evil`, `https://…`); anything else falls back to the dashboard. */
export function safePath(u: unknown): string {
  return typeof u === "string" && u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\") ? u : "/dashboard";
}

/** What a push is about, most specific first. */
export function pushKeys(url: string, tag?: unknown): string[] {
  const keys: string[] = [];
  if (typeof tag === "string" && tag) keys.push(`tag:${tag}`);
  const q = new URL(url, "http://x").searchParams;
  const focus = q.get("focus");
  if (focus) keys.push(`approval:${focus}`);
  const chat = q.get("c");
  if (chat) keys.push(`chat:${chat}`);
  return keys;
}

/** What a realtime approval.created is about (the same keys a push for it carries). */
export function approvalKeys(approvalId: string, conversationId?: string | null): string[] {
  return [`approval:${approvalId}`, ...(conversationId ? [`chat:${conversationId}`] : [])];
}

/** Keys toasted lately, each with the toast id it was shown under. */
export class RecentToasts {
  private seen = new Map<string, { id: string; at: number }>();
  constructor(private ttlMs = 30_000) {}

  /** The toast id already showing for any of these keys (fresh ones only). */
  find(keys: string[], now = Date.now()): string | undefined {
    for (const k of keys) {
      const hit = this.seen.get(k);
      if (hit && now - hit.at < this.ttlMs) return hit.id;
    }
    return undefined;
  }

  mark(keys: string[], id: string, now = Date.now()) {
    for (const [k, v] of this.seen) if (now - v.at >= this.ttlMs) this.seen.delete(k);
    for (const k of keys) this.seen.set(k, { id, at: now });
  }
}

export type PushDecision =
  /** not focused: let the service worker show the system notification */
  | { ack: false }
  /** focused, and a toast for the same thing is already up */
  | { ack: true; toast: null }
  | { ack: true; toast: { id: string; title: string; body?: string; url: string } };

/** What a window does with a push the service worker handed it. */
export function decidePush(d: PushMessage, focused: boolean, recent: RecentToasts, now = Date.now()): PushDecision {
  if (!focused) return { ack: false };
  const title = typeof d.title === "string" ? d.title : "";
  const url = safePath(d.url);
  const keys = pushKeys(url, d.tag);
  if (!title) return { ack: false };
  if (recent.find(keys, now)) return { ack: true, toast: null };
  const id = keys[0] ?? `push:${url}`;
  recent.mark(keys, id, now);
  return { ack: true, toast: { id, title, body: typeof d.body === "string" && d.body ? d.body : undefined, url } };
}
