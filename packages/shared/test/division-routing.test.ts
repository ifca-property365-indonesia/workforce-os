import { describe, expect, it } from "vitest";
import { suggestDivision, type DivisionCandidate } from "../src/division-routing";

const D: DivisionCandidate[] = [
  { id: "del", key: "delivery", name: "Delivery", description: "Squad lintas fungsi yang membawa pekerjaan produk dari permintaan sampai rilis." },
  { id: "sup", key: "support", name: "Support", description: "Menjawab klien, memilah permintaan, dan meneruskan cacat nyata ke Delivery." },
  { id: "fin", key: "finance", name: "Finance & Accounting", description: "Faktur, penagihan berulang, pembukuan, arus kas, dan catatan pajak." },
  { id: "hr", key: "hr", name: "HR", description: "Mengelola karyawan AI: rancangan peran, onboarding, kualitas SOP, dan evaluasi kinerja." },
  { id: "leg", key: null, name: "Legal", description: "Kontrak, perjanjian kerja sama, somasi, dan kepatuhan regulasi." },
];
const pick = (text: string) => suggestDivision(text, D);

describe("division routing", () => {
  it("routes everyday requests to the standard divisions, with the words that decided", () => {
    expect(pick("Buat faktur IPL Oktober untuk Tower A dan kirim pengingat pembayaran")).toMatchObject({ id: "fin", confident: true, matched: expect.arrayContaining(["faktur", "ipl"]) });
    expect(pick("Ada bug di halaman login aplikasi Property365, tolong perbaiki")).toMatchObject({ id: "del", confident: true });
    expect(pick("Balas keluhan penghuni B-07-11 soal air panas")).toMatchObject({ id: "sup", confident: true });
    expect(pick("Rekrut karyawan baru untuk QA dan siapkan onboarding")).toMatchObject({ id: "hr" });
    expect(pick("Make the October invoices and reconcile the payments")).toMatchObject({ id: "fin", confident: true });
  });

  it("a custom division is found by its own name and description", () => {
    expect(pick("Tolong review kontrak perjanjian kerja sama dengan vendor lift")).toMatchObject({ id: "leg", confident: true });
    expect(pick("Minta tim Legal cek ini")).toMatchObject({ id: "leg" });
  });

  it("says nothing without a signal, and is not confident when two divisions tie", () => {
    expect(pick("halo")).toBeNull();
    expect(pick("")).toBeNull();
    const mixed = pick("aplikasi faktur");
    expect(mixed?.confident).toBe(false);
  });
});
