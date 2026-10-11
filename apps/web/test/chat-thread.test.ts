import { describe, expect, it } from "vitest";
import type { ChatMessageDTO } from "@wfos/shared";
import { activeBranch, applyRealtimeMessage, branchInfo, descendantsOf, effectiveLeaf, mergeMessages, newestLeaf, versionsOf, type TreeNode } from "@/lib/chat-thread";

const msg = (id: string, over: Partial<ChatMessageDTO> = {}): ChatMessageDTO => ({
  id,
  conversationId: "c",
  role: "assistant",
  content: "",
  employeeId: "e",
  taskId: null,
  status: "done",
  meta: {},
  createdAt: `2026-10-01T09:00:0${id.length}Z`,
  ...over,
});

describe("mergeMessages", () => {
  it("takes the server row when it is final, even if the local copy has more text", () => {
    const server = [msg("a", { content: "Final answer", status: "done", meta: { chips: [] } })];
    const local = [msg("a", { content: "Final answer plus streamed junk", status: "streaming" })];
    expect(mergeMessages(server, local)).toEqual(server);
  });

  it("carries local text over an empty server row that is not streaming", () => {
    const server = [msg("a", { content: "", status: "error" })];
    const local = [msg("a", { content: "partial", status: "streaming" })];
    expect(mergeMessages(server, local)[0]).toMatchObject({ content: "partial", status: "error" });
  });

  it("keeps the longer streamed text while the server still streams", () => {
    const server = [msg("a", { content: "Hel", status: "streaming" })];
    const local = [msg("a", { content: "Hello wor", status: "streaming" })];
    expect(mergeMessages(server, local)[0]).toMatchObject({ content: "Hello wor", status: "streaming" });
    // the server is ahead: its text wins
    expect(mergeMessages([msg("a", { content: "Hello world", status: "streaming" })], local)[0]!.content).toBe("Hello world");
  });

  it("keeps the final local row (status, meta, taskId) when a stale fetch still says streaming", () => {
    const server = [msg("a", { content: "Hel", status: "streaming", meta: {} })];
    const local = [msg("a", { content: "Hello", status: "done", taskId: "t1", meta: { chips: [{ tool: "x", label: "X" }] } })];
    expect(mergeMessages(server, local)[0]).toMatchObject({ content: "Hello", status: "done", taskId: "t1", meta: { chips: [{ tool: "x", label: "X" }] } });
  });

  it("keeps realtime rows newer than the fetch and drops older unknown ones", () => {
    const server = [msg("a", { createdAt: "2026-10-01T09:00:05Z" })];
    const local = [msg("old", { createdAt: "2026-10-01T09:00:01Z" }), msg("new", { createdAt: "2026-10-01T09:00:09Z" })];
    expect(mergeMessages(server, local).map((m) => m.id)).toEqual(["a", "new"]);
  });

  it("reuses the local object when nothing changed, so memoised rows skip re-rendering", () => {
    const local = [msg("a", { content: "same" })];
    const server = [msg("a", { content: "same" })];
    expect(mergeMessages(server, local)[0]).toBe(local[0]);
  });
});

describe("mergeMessages across branches", () => {
  const at = (s: number) => `2026-10-01T09:00:${String(s).padStart(2, "0")}Z`;

  it("keeps realtime rows that hang below the fetched end, in a chain", () => {
    const server = [msg("u", { role: "user", parentId: null, createdAt: at(1) })];
    const local = [...server, msg("r1", { parentId: "u", createdAt: at(2) }), msg("r2", { parentId: "r1", createdAt: at(3) })];
    expect(mergeMessages(server, local).map((m) => m.id)).toEqual(["u", "r1", "r2"]);
  });

  it("drops the rows of the branch the view left (switching back to an older version)", () => {
    // shown: root v2 → reply; the fetch says the active branch is root v1 → its reply (both older)
    const local = [msg("v2", { role: "user", parentId: null, createdAt: at(5) }), msg("r2", { parentId: "v2", createdAt: at(6) })];
    const server = [msg("v1", { role: "user", parentId: null, createdAt: at(1) }), msg("r1", { parentId: "v1", createdAt: at(2) })];
    expect(mergeMessages(server, local).map((m) => m.id)).toEqual(["v1", "r1"]);
  });

  it("drops a reply left behind by an edit even when it is newer than the fetch", () => {
    const server = [msg("u0", { role: "user", parentId: null, createdAt: at(1) }), msg("e", { role: "user", parentId: "u0", createdAt: at(4) })];
    const local = [msg("u0", { role: "user", parentId: null, createdAt: at(1) }), msg("old", { role: "user", parentId: "u0", createdAt: at(2) }), msg("late", { parentId: "old", createdAt: at(5) })];
    expect(mergeMessages(server, local).map((m) => m.id)).toEqual(["u0", "e"]);
  });
});

describe("branch helpers", () => {
  const n = (id: string, parentId: string | null, s: number, role = "user"): TreeNode => ({ id, parentId, role, createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, s)) });
  // u1 → a1 → u2 → (a2, a2b regenerated);  u1' (edit of u1) → a1'
  const tree = [n("u1", null, 1), n("a1", "u1", 2, "assistant"), n("u2", "a1", 3), n("a2", "u2", 4, "assistant"), n("a2b", "u2", 6, "assistant"), n("u1e", null, 7), n("a1e", "u1e", 8, "assistant")];

  it("newestLeaf walks down the newest child at every step", () => {
    expect(newestLeaf(tree, "u1")).toBe("a2b");
    expect(newestLeaf(tree, "a2")).toBe("a2");
    expect(newestLeaf(tree, "nope")).toBe("nope");
  });

  it("activeBranch is the root-to-leaf path; without a leaf, everything in createdAt order", () => {
    expect(activeBranch(tree, "a2").map((x) => x.id)).toEqual(["u1", "a1", "u2", "a2"]);
    // a stored leaf with replies below it extends to them
    expect(activeBranch(tree, "u1e").map((x) => x.id)).toEqual(["u1e", "a1e"]);
    expect(activeBranch([...tree].reverse(), null).map((x) => x.id)).toEqual(["u1", "a1", "u2", "a2", "a2b", "u1e", "a1e"]);
  });

  it("effectiveLeaf follows the stored leaf down, or falls back to the newest message", () => {
    expect(effectiveLeaf(tree, "u2")).toBe("a2b");
    expect(effectiveLeaf(tree, null)).toBe("a1e");
    expect(effectiveLeaf([], null)).toBeNull();
  });

  it("branchInfo counts siblings of the same kind, oldest first", () => {
    expect(branchInfo(tree, tree[0]!)).toEqual({ index: 0, count: 2, siblingIds: ["u1", "u1e"] });
    expect(branchInfo(tree, tree[4]!)).toEqual({ index: 1, count: 2, siblingIds: ["a2", "a2b"] });
    expect(branchInfo(tree, tree[2]!)).toBeUndefined();
    // a system receipt beside a reply is not a version of it
    expect(branchInfo([...tree, n("sys", "u2", 9, "system")], tree[3]!)).toEqual({ index: 0, count: 2, siblingIds: ["a2", "a2b"] });
  });

  it("versionsOf answers like branchInfo for every message, from one pass over the tree", () => {
    const withSys = [...tree, n("sys", "u2", 9, "system")];
    const v = versionsOf([...withSys].reverse());
    for (const m of withSys) expect(v(m)).toEqual(branchInfo(withSys, m));
  });

  it("descendantsOf lists a subtree (cycle-safe), with or without its root", () => {
    expect(descendantsOf(tree, "a1").sort()).toEqual(["a1", "a2", "a2b", "u2"]);
    expect(descendantsOf(tree, "u1", { self: false }).sort()).toEqual(["a1", "a2", "a2b", "u2"]);
    expect(descendantsOf(tree, "a2b")).toEqual(["a2b"]);
    expect(descendantsOf(tree, "nope", { self: false })).toEqual([]);
    const loop = [n("x", "y", 1), n("y", "x", 2)];
    expect(descendantsOf(loop, "x").sort()).toEqual(["x", "y"]);
  });
});

describe("applyRealtimeMessage", () => {
  const at = (s: number) => `2026-10-01T09:00:${String(s).padStart(2, "0")}Z`;
  const shown = () => [msg("u", { role: "user", parentId: null, createdAt: at(1) }), msg("r", { parentId: "u", createdAt: at(2), branch: { index: 1, count: 2, siblingIds: ["r0", "r"] }, content: "Hi", status: "done" })];

  it("appends a row that continues the shown branch, and decides on the rows as they are now", () => {
    let ms = shown();
    // two events before any render: the second hangs below the first, which the rendered list does not have yet
    const a = applyRealtimeMessage(ms, msg("u2", { role: "user", parentId: "r", createdAt: at(3) }));
    expect(a.refetch).toBe(false);
    ms = a.messages;
    const b = applyRealtimeMessage(ms, msg("r2", { parentId: "u2", createdAt: at(4), status: "streaming" }));
    expect(b.refetch).toBe(false);
    expect(b.messages.map((m) => m.id)).toEqual(["u", "r", "u2", "r2"]);
  });

  it("asks for a refetch instead of appending a row of another branch", () => {
    const ms = shown();
    const r = applyRealtimeMessage(ms, msg("other", { parentId: "u", createdAt: at(5) }));
    expect(r).toEqual({ messages: ms, refetch: true });
    // without a parent field (an older worker): by time
    expect(applyRealtimeMessage(ms, msg("late", { createdAt: at(6) })).refetch).toBe(false);
  });

  it("keeps the fetched branch info, parentId, approvals and streamed text when the payload lacks them", () => {
    const ms = shown();
    const approvals = [{ id: "ap" }] as unknown as ChatMessageDTO["approvals"];
    ms[1] = { ...ms[1]!, approvals };
    const update = msg("r", { createdAt: at(2), content: "", status: "done" });
    delete (update as Partial<ChatMessageDTO>).parentId;
    const r = applyRealtimeMessage(ms, update);
    expect(r.messages[1]).toMatchObject({ parentId: "u", branch: { index: 1, count: 2 }, content: "Hi", approvals });
    expect(r.refetch).toBe(false);
  });

  it("refetches once a streaming reply turns final (so its versions are known)", () => {
    const ms = [...shown().slice(0, 1), msg("r", { parentId: "u", createdAt: at(2), status: "streaming", content: "Hel" })];
    expect(applyRealtimeMessage(ms, msg("r", { parentId: "u", createdAt: at(2), status: "done", content: "Hello" }))).toMatchObject({ refetch: true });
    expect(applyRealtimeMessage(ms, msg("r", { parentId: "u", createdAt: at(2), status: "streaming", content: "Hell" })).refetch).toBe(false);
  });
});
