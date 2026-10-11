import type { ChatMessageDTO } from "@wfos/shared";

const FINAL = new Set(["done", "error"]);

/**
 * Merge a fresh fetch of a conversation into the rows the chat already shows. The server row wins, with two
 * exceptions for a reply the server still reports as "streaming" (the fetch raced the stream):
 * - its text: the longer of the two, since deltas may have delivered more than the fetch saw;
 * - when realtime already delivered the final row (local done/error): that row's text, status, meta and taskId.
 * For every other server row, local text is carried over only when the server text is empty.
 * Messages that arrived over realtime after the fetch (not in it, and not older than its newest row) are kept —
 * but only while they continue the fetched branch: a row that names its parent must hang below the thread's
 * current end, so rows of another branch (left behind by an edit, a regenerate or a version switch) drop out.
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
  let tail = server.at(-1)?.id ?? null;
  const extra: M[] = [];
  for (const m of local) {
    if (known.has(m.id) || m.createdAt < last) continue;
    // a known parent (null = a first message) must be the current end; rows that do not say (an older worker's
    // realtime payload) keep the plain "newer than the fetch" rule
    if (m.parentId !== undefined && (m.parentId ?? null) !== tail) continue;
    extra.push(m);
    tail = m.id;
  }
  return [...merged, ...extra];
}

/**
 * A `chat.message` realtime event against the rows shown. A new row is appended only when it continues the shown
 * branch (its parent is the last row; rows without a parent field — an older worker — by time); otherwise the
 * caller should refetch and let the server say which branch is active. An update to a shown row keeps what the
 * realtime payload does not carry: streamed text while the final text is not in yet, the approvals, the version
 * info (`branch`) and `parentId` the fetch attached. A streaming row turning final also asks for a refetch, so the
 * version switcher learns about the reply it now has a sibling of.
 */
export function applyRealtimeMessage<M extends ChatMessageDTO>(ms: M[], msg: M): { messages: M[]; refetch: boolean } {
  const i = ms.findIndex((m) => m.id === msg.id);
  if (i === -1) {
    const tail = ms.at(-1);
    if (tail) {
      const continues = msg.parentId !== undefined ? msg.parentId === tail.id : msg.createdAt >= tail.createdAt;
      if (!continues) return { messages: ms, refetch: true };
    }
    return { messages: [...ms, msg], refetch: false };
  }
  const prev = ms[i]!;
  const next: M = {
    ...msg,
    content: msg.content || prev.content,
    approvals: msg.approvals ?? prev.approvals,
    branch: msg.branch ?? prev.branch,
    parentId: msg.parentId !== undefined ? msg.parentId : prev.parentId,
  };
  const copy = [...ms];
  copy[i] = next;
  const turnedFinal = prev.status === "streaming" && !!msg.status && FINAL.has(msg.status);
  return { messages: copy, refetch: turnedFinal };
}

// ---------------------------------------------------------------------------
// Branches: a conversation is a tree (messages.parent_id); the thread shown is one root-to-leaf path.
// ---------------------------------------------------------------------------

/** The fields the tree walks need; works for DB rows (Date) and DTOs (ISO string) alike. */
export interface TreeNode {
  id: string;
  parentId?: string | null;
  role: string;
  createdAt: string | Date;
}

const stamp = (d: string | Date) => (typeof d === "string" ? new Date(d).getTime() : d.getTime());
/** oldest first; ties by id, the same order the conversation query uses */
const byAge = (a: TreeNode, b: TreeNode) => stamp(a.createdAt) - stamp(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function childrenOf<N extends TreeNode>(nodes: readonly N[]): Map<string | null, N[]> {
  const kids = new Map<string | null, N[]>();
  for (const n of [...nodes].sort(byAge)) {
    const k = n.parentId ?? null;
    const list = kids.get(k) ?? [];
    list.push(n);
    kids.set(k, list);
  }
  return kids;
}

/**
 * The deepest descendant of `fromId`, picking the newest child at every step (the version last written).
 * Unknown ids come back unchanged. Guards against cycles in malformed data.
 */
export function newestLeaf(nodes: readonly TreeNode[], fromId: string): string {
  const kids = childrenOf(nodes);
  const seen = new Set<string>();
  let at = fromId;
  while (!seen.has(at)) {
    seen.add(at);
    const next = kids.get(at)?.at(-1);
    if (!next) break;
    at = next.id;
  }
  return at;
}

/**
 * Where the thread currently ends: the stored active leaf followed down to its newest descendant (replies the
 * worker attached below it), or, when no leaf is stored (legacy linear threads), the newest message.
 */
export function effectiveLeaf(nodes: readonly TreeNode[], activeLeafId: string | null): string | null {
  if (activeLeafId && nodes.some((n) => n.id === activeLeafId)) return newestLeaf(nodes, activeLeafId);
  return [...nodes].sort(byAge).at(-1)?.id ?? null;
}

/**
 * The messages on the active branch, root first: walk up from the leaf via parentId. Without a stored leaf the
 * conversation predates branching and is shown whole in createdAt order.
 */
export function activeBranch<N extends TreeNode>(nodes: readonly N[], activeLeafId: string | null): N[] {
  if (!activeLeafId || !nodes.some((n) => n.id === activeLeafId)) return [...nodes].sort(byAge);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: N[] = [];
  const seen = new Set<string>();
  let at = byId.get(newestLeaf(nodes, activeLeafId));
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.push(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path.reverse();
}

export interface BranchInfo {
  /** 0-based position among its versions (oldest first) */
  index: number;
  count: number;
  siblingIds: string[];
}

const versionKind = (r: string) => (r === "user" ? "user" : r === "assistant" ? "assistant" : `other:${r}`);

/**
 * The versions of a message: its siblings (same parent) of the same kind — user messages count user edits,
 * replies count regenerated replies, so a system receipt next to a reply is never a "version" of it.
 * Undefined when there is only one.
 */
export function branchInfo(nodes: readonly TreeNode[], m: TreeNode): BranchInfo | undefined {
  return versionsOf(nodes)(m);
}

/**
 * `branchInfo` for many messages of one tree: the siblings are grouped once (parent × kind), so asking for every
 * message on a long branch stays linear instead of scanning the whole tree per message.
 */
export function versionsOf(nodes: readonly TreeNode[]): (m: TreeNode) => BranchInfo | undefined {
  const groups = new Map<string, string[]>();
  for (const n of [...nodes].sort(byAge)) {
    const k = `${n.parentId ?? ""}|${versionKind(n.role)}`;
    const list = groups.get(k) ?? [];
    list.push(n.id);
    groups.set(k, list);
  }
  return (m) => {
    const ids = groups.get(`${m.parentId ?? ""}|${versionKind(m.role)}`);
    if (!ids || ids.length < 2) return undefined;
    return { index: ids.indexOf(m.id), count: ids.length, siblingIds: [...ids] };
  };
}

/** `rootId` and everything below it (cycle-safe); with `self: false` only what is below it. */
export function descendantsOf(nodes: readonly TreeNode[], rootId: string, { self = true }: { self?: boolean } = {}): string[] {
  const kids = childrenOf(nodes);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (at !== rootId || self) out.push(at);
    for (const k of kids.get(at) ?? []) stack.push(k.id);
  }
  return out;
}
