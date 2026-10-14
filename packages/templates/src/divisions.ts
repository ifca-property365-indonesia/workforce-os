/**
 * The standard organisation: a cross-functional Delivery squad (product work) and functional divisions that serve
 * everyone (Support, Finance & Accounting, HR). A workspace gets its own editable copy (Divisions page).
 */
import type { Bilingual, TeamMemberRole } from "@wfos/shared";

export interface DivisionMemberTemplate {
  /** ROLE_TEMPLATES key */
  role: string;
  /** subagent: works inside the code lead's sandbox run */
  membership: TeamMemberRole;
}

export interface DivisionTemplate {
  key: string;
  name: Bilingual;
  description: Bilingual;
  color: string;
  sop: Bilingual;
  /** ROLE_TEMPLATES key of the head */
  head: string;
  /** ROLE_TEMPLATES key of the code lead (Workspace mode), if the division writes code */
  codeLead?: string;
  members: DivisionMemberTemplate[];
  maxParallel: number;
}

const lines = (xs: string[]) => xs.join("\n");

export const DIVISION_TEMPLATES: DivisionTemplate[] = [
  {
    key: "delivery",
    name: { en: "Delivery", id: "Delivery" },
    description: {
      en: "Cross-functional squad that takes product work from request to release: PM, Tech Lead, Frontend, Backend, UI/UX, QA.",
      id: "Squad lintas fungsi yang membawa pekerjaan produk dari permintaan sampai rilis: PM, Tech Lead, Frontend, Backend, UI/UX, QA.",
    },
    color: "#4f7cff",
    head: "project_manager",
    codeLead: "tech_lead",
    members: [
      { role: "tech_lead", membership: "member" },
      { role: "uiux", membership: "member" },
      { role: "frontend", membership: "subagent" },
      { role: "backend", membership: "subagent" },
      { role: "qa", membership: "subagent" },
    ],
    maxParallel: 1,
    sop: {
      en: lines([
        "1. The PM owns what and why (scope, priority, acceptance criteria); the Tech Lead owns how (design of the code, quality, integration).",
        "2. New features and scope changes start with a PRD (draft_document kind \"prd\") that the owner approves. Small fixes go straight to the Tech Lead.",
        "3. Order the work: UI/UX design first when the change has a user interface, then the build (delegate_subtask with `after`). The design deliverable is passed to the build.",
        "4. The Tech Lead builds in one sandbox on one branch with Frontend, Backend and QA as subagents. Tests (and linter/typechecker) pass before the push.",
        "5. git_push and request_preview go through approval; a preview is live only once the platform reports it deployed. LIVE only when the task asks for it, and only an Owner approves.",
        "6. The PM checks the result against the acceptance criteria and reports: what changed, preview link, test results, open items.",
        "7. Hand off with handoff_to_division: a billable milestone that went LIVE → Finance & Accounting; release notes for a client → Support.",
      ]),
      id: lines([
        "1. PM memegang apa dan kenapa (cakupan, prioritas, kriteria penerimaan); Tech Lead memegang bagaimana (rancangan kode, kualitas, integrasi).",
        "2. Fitur baru dan perubahan cakupan dimulai dengan PRD (draft_document kind \"prd\") yang disetujui pemilik. Perbaikan kecil langsung ke Tech Lead.",
        "3. Urutkan pekerjaan: desain UI/UX dulu bila perubahan menyentuh tampilan, lalu build (delegate_subtask dengan `after`). Hasil desain diteruskan ke build.",
        "4. Tech Lead membangun di satu sandbox dan satu branch bersama Frontend, Backend, dan QA sebagai subagen. Tes (dan linter/typechecker) lulus sebelum push.",
        "5. git_push dan request_preview melalui persetujuan; preview baru live setelah platform melaporkan ter-deploy. LIVE hanya jika tugas memintanya, dan hanya Owner yang menyetujui.",
        "6. PM memeriksa hasil terhadap kriteria penerimaan dan melapor: apa yang berubah, tautan preview, hasil tes, hal yang masih terbuka.",
        "7. Serah terima dengan handoff_to_division: milestone berbayar yang sudah LIVE → Finance & Accounting; catatan rilis untuk klien → Support.",
      ]),
    },
  },
  {
    key: "support",
    name: { en: "Support", id: "Support" },
    description: {
      en: "Answers clients, triages requests and escalates real defects to Delivery.",
      id: "Menjawab klien, memilah permintaan, dan meneruskan cacat nyata ke Delivery.",
    },
    color: "#18a999",
    head: "support_lead",
    members: [{ role: "customer_support", membership: "member" }],
    maxParallel: 2,
    sop: {
      en: lines([
        "1. Triage: client, product, severity (P1 outage, P2 broken feature, P3 minor, P4 question), what the client expects.",
        "2. Answer from the knowledge base and cite it; when the answer is not there, say so and escalate. Never invent policies, dates or prices.",
        "3. Client emails are drafts first (draft_email); sending goes through approval.",
        "4. A real defect goes to Delivery with handoff_to_division: steps to reproduce, expected vs actual, client, severity, screenshots or logs if given.",
        "5. Close the loop: tell the client what happens next and follow up when Delivery reports back.",
      ]),
      id: lines([
        "1. Pilah: klien, produk, tingkat keparahan (P1 mati total, P2 fitur rusak, P3 minor, P4 pertanyaan), harapan klien.",
        "2. Jawab dari basis pengetahuan dan sebutkan sumbernya; bila tidak ada, katakan terus terang dan teruskan. Jangan mengarang kebijakan, tanggal, atau harga.",
        "3. Email ke klien dibuat sebagai draf dulu (draft_email); pengiriman melalui persetujuan.",
        "4. Cacat nyata diteruskan ke Delivery dengan handoff_to_division: langkah reproduksi, hasil yang diharapkan vs yang terjadi, klien, tingkat keparahan, tangkapan layar atau log bila ada.",
        "5. Tuntaskan: beri tahu klien langkah berikutnya dan tindak lanjuti setelah Delivery melapor.",
      ]),
    },
  },
  {
    key: "finance",
    name: { en: "Finance & Accounting", id: "Finance & Accounting" },
    description: {
      en: "Invoices, recurring billing, bookkeeping, cash flow and tax notes.",
      id: "Faktur, penagihan berulang, pembukuan, arus kas, dan catatan pajak.",
    },
    color: "#e0a526",
    head: "finance_lead",
    members: [
      { role: "billing", membership: "member" },
      { role: "accountant", membership: "member" },
    ],
    maxParallel: 1,
    sop: {
      en: lines([
        "1. Use client and project rates from master data; never invent amounts.",
        "2. Invoice numbers: the next number from list_invoices (the ledger); never reuse one. Line items and tax must add up before sending is proposed.",
        "3. Recurring billing: list what is due this period and draft it; sending needs approval.",
        "4. Bookkeeping: every journal line names its source document. Monthly: revenue, receivables, overdue items, tax notes (PPN, PPh).",
        "5. Money in the client's currency; Rupiah as Rp 1.234.567. Mark anything that needs a certified accountant's judgement.",
      ]),
      id: lines([
        "1. Gunakan tarif klien dan proyek dari master data; jangan mengarang angka.",
        "2. Nomor faktur: nomor berikutnya dari list_invoices (buku faktur); jangan pernah memakai ulang. Rincian dan pajak harus cocok sebelum pengiriman diusulkan.",
        "3. Penagihan berulang: daftar tagihan yang jatuh tempo periode ini dan buat drafnya; pengiriman memerlukan persetujuan.",
        "4. Pembukuan: setiap baris jurnal menyebut dokumen sumbernya. Bulanan: pendapatan, piutang, tagihan lewat jatuh tempo, catatan pajak (PPN, PPh).",
        "5. Uang dalam mata uang klien; Rupiah sebagai Rp 1.234.567. Tandai hal yang memerlukan penilaian akuntan bersertifikat.",
      ]),
    },
  },
  {
    key: "hr",
    name: { en: "HR", id: "HR" },
    description: {
      en: "Looks after the AI workforce: role design, onboarding, SOP quality and performance reviews.",
      id: "Mengelola karyawan AI: rancangan peran, onboarding, kualitas SOP, dan evaluasi kinerja.",
    },
    color: "#c2508a",
    head: "hr_lead",
    members: [{ role: "people_analyst", membership: "member" }],
    maxParallel: 1,
    sop: {
      en: lines([
        "1. HR's people are the workspace's AI employees. Judge by the record (tasks, revisions, rejected approvals, incidents, cost) and link to it.",
        "2. Propose, never impose: new employees and changes to instructions, tools, models or autonomy are proposals the owner decides.",
        "3. A new role comes as a complete profile: role, specialty, persona, instructions, tools, model, division, and why it is needed.",
        "4. SOP reviews name what is ambiguous, missing or contradictory and suggest the wording.",
        "5. Separate facts from inferences; say when the data is too thin to judge.",
      ]),
      id: lines([
        "1. Yang dikelola HR adalah karyawan AI workspace ini. Nilai berdasarkan rekam jejak (tugas, revisi, persetujuan yang ditolak, insiden, biaya) dan tautkan buktinya.",
        "2. Usulkan, jangan paksakan: karyawan baru dan perubahan instruksi, tool, model, atau autonomy adalah usulan yang diputuskan pemilik.",
        "3. Peran baru diusulkan sebagai profil lengkap: peran, keahlian, persona, instruksi, tool, model, divisi, dan alasan dibutuhkan.",
        "4. Tinjauan SOP menyebut bagian yang ambigu, kurang, atau bertentangan beserta usulan kalimatnya.",
        "5. Pisahkan fakta dari dugaan; katakan bila datanya terlalu sedikit untuk menilai.",
      ]),
    },
  },
];

export const DIVISION_BY_KEY: Record<string, DivisionTemplate> = Object.fromEntries(DIVISION_TEMPLATES.map((d) => [d.key, d]));
