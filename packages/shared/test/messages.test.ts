import { describe, expect, it } from "vitest";
import { MESSAGE_CATALOG, msg } from "../src/messages";

describe("worker message templates", () => {
  it("id and en have the same keys and placeholders", () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    expect(Object.keys(MESSAGE_CATALOG.id).sort()).toEqual(Object.keys(MESSAGE_CATALOG.en).sort());
    for (const k of Object.keys(MESSAGE_CATALOG.en) as (keyof typeof MESSAGE_CATALOG.en)[]) {
      expect(ph(MESSAGE_CATALOG.id[k]), k).toBe(ph(MESSAGE_CATALOG.en[k]));
    }
  });
  it("substitutes values and falls back to English", () => {
    expect(msg("id", "notify.taskFinished", { title: "Laporan" })).toBe("Tugas selesai: Laporan");
    expect(msg(null, "notify.taskFinished", { title: "Report" })).toBe("Task finished: Report");
  });
});
