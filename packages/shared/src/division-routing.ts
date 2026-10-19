/**
 * Which division a piece of work belongs to, from its words: the standard divisions' keywords (Indonesian and
 * English), and for any division its own name and description. Deterministic and explainable (the matched words are
 * shown); no model call. A person sees the suggestion and can change it.
 */

export const DIVISION_KEYWORDS: Record<string, string[]> = {
  delivery: [
    "aplikasi", "app", "apps", "fitur", "feature", "bug", "error", "halaman", "page", "website", "web", "api", "deploy", "rilis", "release",
    "modul", "module", "prd", "desain", "design", "ui", "ux", "frontend", "backend", "database", "kode", "code", "coding", "bangun", "build",
    "integrasi", "integration", "login", "tampilan", "layout", "mobile", "android", "ios", "server", "preview", "repo", "repository", "uji aplikasi",
    "test", "qa", "figma", "dashboard", "dasbor", "form", "formulir", "migrasi", "migration",
  ],
  support: [
    "keluhan", "komplain", "complaint", "tiket", "ticket", "pelanggan", "customer", "pertanyaan", "question", "bantuan", "help", "balas", "reply",
    "membalas", "email masuk", "inbox", "respon", "response", "sla", "eskalasi", "escalate", "penghuni", "tenant", "keberatan", "laporan masalah",
  ],
  finance: [
    "faktur", "invoice", "tagihan", "billing", "bayar", "payment", "pembayaran", "pajak", "tax", "ppn", "pph", "efaktur", "jurnal", "journal",
    "pembukuan", "bookkeeping", "akuntansi", "accounting", "kas", "cash", "arus kas", "cash flow", "laporan keuangan", "financial report",
    "neraca", "balance sheet", "laba", "rugi", "budget", "anggaran", "piutang", "utang", "receivable", "payable", "rekonsiliasi", "reconcile",
    "gaji", "payroll", "kuitansi", "receipt", "ipl",
  ],
  hr: [
    "karyawan", "employee", "rekrut", "recruit", "rekrutmen", "hire", "hiring", "onboarding", "sop", "evaluasi karyawan", "review hr", "kinerja",
    "performance review", "peran", "role", "pelatihan", "training", "cuti", "leave", "hr", "sdm",
  ],
};

const STOP = new Set(
  "yang dan atau untuk dari dengan pada ke di dalam ini itu ada akan dapat bisa kita kami saya anda mereka tim the and or for from with to in on of a an is are be this that our your".split(" "),
);

export interface DivisionCandidate {
  id: string;
  key: string | null;
  name: string;
  description: string;
}
export interface DivisionSuggestion {
  id: string;
  score: number;
  /** the words that matched, for the person to see why */
  matched: string[];
  /** clearly ahead of the next division: fine to preselect */
  confident: boolean;
}

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;

export function suggestDivision(text: string, divisions: DivisionCandidate[]): DivisionSuggestion | null {
  const t = norm(text);
  if (t.trim().length < 3 || !divisions.length) return null;
  const scored = divisions.map((d) => {
    const matched = new Set<string>();
    let score = 0;
    const hit = (word: string, weight: number) => {
      const w = norm(word).trim();
      if (w.length < 2 || matched.has(w) || !t.includes(` ${w} `)) return;
      matched.add(w);
      score += weight;
    };
    for (const k of d.key ? (DIVISION_KEYWORDS[d.key] ?? []) : []) hit(k, k.includes(" ") ? 3 : 2);
    // the division's own name (mentioning it is a strong signal) and description words
    hit(d.name, 4);
    for (const w of norm(d.description).trim().split(" ")) if (w.length >= 4 && !STOP.has(w)) hit(w, 1);
    return { id: d.id, score, matched: [...matched] };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score === 0) return null;
  return { id: best.id, score: best.score, matched: best.matched.slice(0, 5), confident: best.score >= 2 && best.score >= (next?.score ?? 0) * 1.5 };
}
