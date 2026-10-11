import type { ChatMessageDTO } from "@wfos/shared";

const FINAL = new Set(["done", "error"]);

/**
 * Merge a fresh fetch of a conversation into the rows the chat already shows. The server row wins, with two
 * exceptions for a reply the server still reports as "streaming" (the fetch raced the stream):
 * - its text: the longer of the two, since deltas may have delivered more than the fetch saw;
 * - when realtime already delivered the final row (local done/error): that row's text, status, meta and taskId.
 * For every other server row, local text is carried over only when the server text is empty.
 * Messages that arrived over realtime after the fetch (not in it, and not older than its newest row) are kept.
 * A row that ends up identical to the local one keeps the local object, so memoised rows do not re-render.
 */
export function mergeMessages<M extends ChatMessageDTO>(server: M[], local: M[]): M[] {
  const byId = new Map(local.map((m) => [m.id, m]));
  const known = new Set(server.map((m) => m.id));
  const merged = server.map((s): M => {
    const l = byId.get(s.id);
    if (!l) return s;
    let out: M = s;
    if (s.status === "streaming") {
      if (l.status && FINAL.has(l.status)) out = { ...s, content: l.content || s.content, status: l.status, meta: l.meta, taskId: l.taskId };
      else if (l.content.length > s.content.length) out = { ...s, content: l.content };
    } else if (!s.content && l.content) {
      out = { ...s, content: l.content };
    }
    return JSON.stringify(out) === JSON.stringify(l) ? l : out;
  });
  const last = server.at(-1)?.createdAt ?? "";
  return [...merged, ...local.filter((m) => !known.has(m.id) && m.createdAt >= last)];
}
