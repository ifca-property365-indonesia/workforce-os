import { describe, expect, it } from "vitest";
import type { ChatMessageDTO } from "@wfos/shared";
import { mergeMessages } from "@/lib/chat-thread";

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
