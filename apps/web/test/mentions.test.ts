import { describe, expect, it } from "vitest";
import { activeMention, insertMention, mentionMatches, mentionSuppressed, parseMentions } from "@/lib/mentions";

const budi = { id: "b", name: "Budi" };
const budiS = { id: "bs", name: "Budi Santoso" };
const sari = { id: "s", name: "Sari" };
const team = [sari, budi, budiS];

describe("parseMentions", () => {
  it("finds a single-word name, case-insensitively", () => {
    expect(parseMentions("hi @sari, can you check?", team)).toEqual({ mentions: ["s"], mentionAll: false });
    expect(parseMentions("@SARI", team).mentions).toEqual(["s"]);
  });

  it("prefers the longest name: @Budi Santoso is not @Budi", () => {
    expect(parseMentions("@Budi Santoso please", team).mentions).toEqual(["bs"]);
    expect(parseMentions("@budi santoso", team).mentions).toEqual(["bs"]);
    expect(parseMentions("@Budi said so", team).mentions).toEqual(["b"]);
    expect(parseMentions("@Budi   Santoso", team).mentions).toEqual(["bs"]);
  });

  it("@semua and @everyone address everyone", () => {
    expect(parseMentions("@semua tolong cek", team)).toEqual({ mentions: [], mentionAll: true });
    expect(parseMentions("Hey @Everyone!", team)).toEqual({ mentions: [], mentionAll: true });
    expect(parseMentions("@semuanya", team).mentionAll).toBe(false);
  });

  it("dedups and returns ids in team order, not message order", () => {
    expect(parseMentions("@Budi then @Sari then @budi again", team).mentions).toEqual(["s", "b"]);
    expect(parseMentions("@Sari @Sari", [sari, sari]).mentions).toEqual(["s"]);
  });

  it("needs a word boundary on both sides", () => {
    expect(parseMentions("mail budi@example.com", team).mentions).toEqual([]);
    expect(parseMentions("@Budiman is not here", team).mentions).toEqual([]);
    expect(parseMentions("(@Sari)", team).mentions).toEqual(["s"]);
    expect(parseMentions("@Sari.", team).mentions).toEqual(["s"]);
  });

  it("ignores names that are not team members and blank names", () => {
    expect(parseMentions("@Rina and @Sari", [sari, { id: "x", name: "  " }]).mentions).toEqual(["s"]);
    expect(parseMentions("@ alone", team)).toEqual({ mentions: [], mentionAll: false });
    expect(parseMentions("no mentions here", [])).toEqual({ mentions: [], mentionAll: false });
  });

  it("handles names with non-ASCII letters", () => {
    expect(parseMentions("@josé ok", [{ id: "j", name: "José" }]).mentions).toEqual(["j"]);
    expect(parseMentions("@Joséphine", [{ id: "j", name: "José" }]).mentions).toEqual([]);
  });
});

describe("composer helpers", () => {
  it("activeMention finds the @query before the caret", () => {
    expect(activeMention("hi @Bu", 6)).toEqual({ start: 3, query: "Bu" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("@Budi S", 7)).toEqual({ start: 0, query: "Budi S" });
    expect(activeMention("mail a@b", 8)).toBeNull();
    expect(activeMention("@x\nnext", 7)).toBeNull();
    expect(activeMention("@ space", 7)).toBeNull();
    expect(activeMention("no at", 5)).toBeNull();
  });

  it("mentionMatches the start of the name or any word", () => {
    expect(mentionMatches("Budi Santoso", "bu")).toBe(true);
    expect(mentionMatches("Budi Santoso", "san")).toBe(true);
    expect(mentionMatches("Budi Santoso", "budi s")).toBe(true);
    expect(mentionMatches("Budi Santoso", "x")).toBe(false);
    expect(mentionMatches("Sari", "")).toBe(true);
  });

  it("insertMention replaces the typed query and puts the caret after the space", () => {
    expect(insertMention("hi @Bu", { start: 3, query: "Bu" }, 6, "Budi Santoso")).toEqual({ text: "hi @Budi Santoso ", caret: 17 });
    expect(insertMention("@Sa please", { start: 0, query: "Sa" }, 3, "Sari")).toEqual({ text: "@Sari please", caret: 6 });
  });

  it("insertMention replaces the whole token when the caret is mid-name (no duplicated tail)", () => {
    // caret between "Sa" and "ri"
    expect(insertMention("hi @Sari please", { start: 3, query: "Sa" }, 6, "Sari")).toEqual({ text: "hi @Sari please", caret: 9 });
    expect(insertMention("@Sari", { start: 0, query: "Sa" }, 3, "Sari Dewi")).toEqual({ text: "@Sari Dewi ", caret: 11 });
    // the full multi-word name already follows the "@": all of it is replaced, not just "Budi"
    expect(insertMention("@Budi Santoso, ok?", { start: 0, query: "Bu" }, 3, "Budi Santoso")).toEqual({ text: "@Budi Santoso, ok?", caret: 13 });
    expect(insertMention("@budi santoso ok", { start: 0, query: "bu" }, 3, "Budi Santoso")).toEqual({ text: "@Budi Santoso ok", caret: 14 });
    expect(insertMention("ask @Sa. Then", { start: 4, query: "Sa" }, 7, "Sari")).toEqual({ text: "ask @Sari. Then", caret: 9 });
    // a shorter name keeps the following words
    expect(insertMention("@Budi Santoso", { start: 0, query: "Bu" }, 3, "Budi")).toEqual({ text: "@Budi Santoso", caret: 6 });
    // "@Budiman" is not "@Budi": only the rest of the word under the caret goes
    expect(insertMention("@Budiman x", { start: 0, query: "Bu" }, 3, "Budi")).toEqual({ text: "@Budi x", caret: 6 });
  });

  it("mentionSuppressed keeps the list closed after a pick until the text changes, and after Escape for that @", () => {
    const team2 = [{ name: "Sari" }, { name: "Sari Dewi" }];
    const picked = insertMention("@Sa", { start: 0, query: "Sa" }, 3, "Sari");
    const active = activeMention(picked.text, picked.caret)!;
    // "@Sari " still matches "Sari Dewi", which is why the list would reopen without the pick memory
    expect(active).toEqual({ start: 0, query: "Sari " });
    expect(team2.some((m) => mentionMatches(m.name, active.query))).toBe(true);
    expect(mentionSuppressed(active, picked.text, null, { start: 0, text: picked.text })).toBe(true);
    // typing again reopens it
    const typed = `${picked.text}D`;
    expect(mentionSuppressed(activeMention(typed, typed.length)!, typed, null, { start: 0, text: picked.text })).toBe(false);
    // a pick of another "@" does not suppress this one
    expect(mentionSuppressed({ start: 5, query: "B" }, "@Sari @B", null, { start: 0, text: "@Sari @B" })).toBe(false);
    // Escape for this "@" keeps it closed while typing on; another "@" opens normally
    expect(mentionSuppressed({ start: 0, query: "Sar" }, "@Sar", 0, null)).toBe(true);
    expect(mentionSuppressed({ start: 6, query: "" }, "@Sar, @", 0, null)).toBe(false);
  });
});
