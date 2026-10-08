import { describe, expect, it } from "vitest";
import { createFormatter } from "@/lib/format";

const nbsp = (s: string) => s.replace(/[  ]/g, " ");
const NOW = Date.parse("2026-10-08T05:00:00Z");
const id = createFormatter("id", "Asia/Jakarta", () => NOW);
const en = createFormatter("en", "Asia/Jakarta", () => NOW);

describe("locale formatting", () => {
  it("formats rupiah the Indonesian way", () => {
    expect(nbsp(id.money(1234567, "IDR"))).toBe("Rp 1.234.567");
    expect(nbsp(en.money(1234567, "IDR"))).toBe("IDR 1,234,567");
  });

  it("formats numbers per locale", () => {
    expect(id.number(1234.5)).toBe("1.234,5");
    expect(en.number(1234.5)).toBe("1,234.5");
    expect(id.credits(1234.567)).toBe("1.234,57");
    expect(en.credits(0.5)).toBe("0.500");
  });

  it("formats dates in the configured time zone", () => {
    // 05:00 UTC = 12:00 WIB
    expect(id.time("2026-10-08T05:00:00Z")).toBe("12.00");
    expect(en.time("2026-10-08T05:00:00Z")).toMatch(/^12:00/);
    expect(id.date("2026-10-08T05:00:00Z")).toBe("8 Okt 2026");
    expect(en.date("2026-10-08T05:00:00Z")).toBe("Oct 8, 2026");
  });

  it("formats relative time per locale", () => {
    expect(id.ago(new Date(NOW - 5 * 60_000))).toMatch(/5 mnt/);
    expect(en.ago(new Date(NOW - 5 * 60_000))).toBe("5 min. ago");
    expect(en.ago(null)).toBe("—");
  });
});
