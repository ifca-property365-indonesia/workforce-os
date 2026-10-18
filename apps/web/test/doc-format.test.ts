import { describe, expect, it } from "vitest";
import { lineDiff, parseFlow, screenshotNumber, splitSlides } from "@/lib/doc-format";

describe("app document formats (C9)", () => {
  it("parses a flow block: title, start, role steps, a decision with yes/no, end", () => {
    const f = parseFlow(["judul: Permintaan pembelian", "mulai: Butuh barang", "Requester: Buat permintaan", "? Di atas 10 juta?", "  ya: Ke Direktur", "  tidak: Ke Manager", "Sistem: Kirim email", "selesai: PO terbit", "baris aneh"].join("\n"));
    expect(f.title).toBe("Permintaan pembelian");
    expect(f.items).toEqual([
      { type: "start", text: "Butuh barang" },
      { type: "step", role: "Requester", text: "Buat permintaan" },
      { type: "decision", question: "Di atas 10 juta?", yes: "Ke Direktur", no: "Ke Manager" },
      { type: "step", role: "Sistem", text: "Kirim email" },
      { type: "end", text: "PO terbit" },
      { type: "step", role: "", text: "baris aneh" },
    ]);
  });

  it("diffs lines against the approved version", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
      { op: "add", text: "d" },
    ]);
  });

  it("splits slides on --- outside code, and reads #n screenshot targets only", () => {
    expect(splitSlides("# A\n---\n## B\n```\n---\n```\n---\n\n")).toEqual(["# A", "## B\n```\n---\n```"]);
    expect(screenshotNumber("#3")).toBe(3);
    expect(screenshotNumber("https://evil.example/x.png")).toBeNull();
    expect(screenshotNumber("#3 onerror=x")).toBeNull();
  });
});
