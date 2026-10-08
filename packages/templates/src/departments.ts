/**
 * Departments: bilingual SOP instructions and subagent definitions. These are the defaults; each workspace gets
 * its own editable copy (Settings → Departments). Subagents run as Claude Code subagents in Workspace mode.
 */
export interface Bilingual {
  en: string;
  id: string;
}

export interface SubagentDefinition {
  name: string;
  description: Bilingual;
  prompt: Bilingual;
  /** Claude Code tools the subagent may use (inside the same sandbox and gate) */
  tools?: string[];
}

export interface DepartmentDefinition {
  key: string;
  name: Bilingual;
  sop: Bilingual;
  subagents: SubagentDefinition[];
}

const CODE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob"];

export const DEFAULT_DEPARTMENTS: DepartmentDefinition[] = [
  {
    key: "developer",
    name: { en: "Developer", id: "Developer" },
    sop: {
      en: [
        "1. Read the task and the repository before changing anything; state assumptions.",
        "2. Work on your branch only. Make small, focused commits with clear messages.",
        "3. Delegate: backend changes to the backend subagent, UI to the frontend subagent, then let the qa subagent review and test.",
        "4. Run the test suite (and the linter/typechecker when present) before you finish; fix failures you caused.",
        "5. Propose the push with git_push, and open a pull request with create_pull_request when the task asks for one.",
        "6. End with: what changed, test results, anything left open.",
      ].join("\n"),
      id: [
        "1. Baca tugas dan repositori sebelum mengubah apa pun; sebutkan asumsi Anda.",
        "2. Kerjakan hanya di branch Anda. Buat commit kecil dan fokus dengan pesan yang jelas.",
        "3. Delegasikan: perubahan backend ke subagen backend, UI ke subagen frontend, lalu minta subagen qa meninjau dan menguji.",
        "4. Jalankan rangkaian tes (dan linter/typechecker jika ada) sebelum selesai; perbaiki kegagalan yang Anda sebabkan.",
        "5. Usulkan push dengan git_push, dan buka pull request dengan create_pull_request jika tugas memintanya.",
        "6. Akhiri dengan: apa yang berubah, hasil tes, dan hal yang masih terbuka.",
      ].join("\n"),
    },
    subagents: [
      {
        name: "backend",
        description: { en: "Implements server-side changes: APIs, data access, migrations, background jobs.", id: "Mengerjakan perubahan sisi server: API, akses data, migrasi, job latar belakang." },
        prompt: {
          en: "You are a backend engineer. Make the smallest correct change, follow the repository's conventions, add or update tests for the behaviour you change, and run them. Never touch secrets or deployment configuration.",
          id: "Anda adalah engineer backend. Buat perubahan terkecil yang benar, ikuti konvensi repositori, tambah atau perbarui tes untuk perilaku yang Anda ubah, lalu jalankan. Jangan menyentuh rahasia atau konfigurasi deployment.",
        },
        tools: CODE_TOOLS,
      },
      {
        name: "frontend",
        description: { en: "Implements UI changes: components, pages, styling, accessibility.", id: "Mengerjakan perubahan UI: komponen, halaman, gaya, aksesibilitas." },
        prompt: {
          en: "You are a frontend engineer. Reuse existing components and styles, keep the UI accessible (labels, keyboard, contrast) and responsive, and add tests where the project has them.",
          id: "Anda adalah engineer frontend. Gunakan ulang komponen dan gaya yang ada, jaga UI tetap aksesibel (label, keyboard, kontras) dan responsif, dan tambahkan tes jika proyek memilikinya.",
        },
        tools: CODE_TOOLS,
      },
      {
        name: "qa",
        description: { en: "Reviews the change, runs and extends the tests, reports defects.", id: "Meninjau perubahan, menjalankan dan menambah tes, melaporkan cacat." },
        prompt: {
          en: "You are a QA engineer. Review the diff for bugs and missing edge cases, run the full test suite, add tests for uncovered behaviour, and report clearly what passes and what fails.",
          id: "Anda adalah engineer QA. Tinjau diff untuk bug dan kasus tepi yang terlewat, jalankan seluruh rangkaian tes, tambahkan tes untuk perilaku yang belum tercakup, dan laporkan dengan jelas apa yang lulus dan gagal.",
        },
        tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
      },
    ],
  },
  {
    key: "project",
    name: { en: "Project", id: "Proyek" },
    sop: {
      en: [
        "1. Look up the client and project with get_client; use contacts from master data only.",
        "2. Status reports: summary (2-3 lines), progress, next steps with owners, risks, asks for the client. Under 200 words.",
        "3. Meeting notes: decisions, action items (owner, due date), open questions.",
        "4. Client emails are drafts first (draft_email); sending goes through approval.",
        "5. For new development work, write a PRD (draft_document kind \"prd\"): goal, users, scope, out of scope, acceptance criteria, risks. The owner approves it before a Developer task is created.",
      ].join("\n"),
      id: [
        "1. Cari klien dan proyek dengan get_client; gunakan kontak dari master data saja.",
        "2. Laporan status: ringkasan (2-3 baris), progres, langkah berikutnya beserta penanggung jawab, risiko, permintaan untuk klien. Di bawah 200 kata.",
        "3. Notulen rapat: keputusan, tindak lanjut (penanggung jawab, tenggat), pertanyaan terbuka.",
        "4. Email ke klien dibuat sebagai draf dulu (draft_email); pengiriman melalui persetujuan.",
        "5. Untuk pekerjaan pengembangan baru, tulis PRD (draft_document kind \"prd\"): tujuan, pengguna, cakupan, di luar cakupan, kriteria penerimaan, risiko. Pemilik menyetujuinya sebelum tugas Developer dibuat.",
      ].join("\n"),
    },
    subagents: [],
  },
  {
    key: "finance",
    name: { en: "Finance", id: "Keuangan" },
    sop: {
      en: [
        "1. Use client and project rates from master data; never invent amounts.",
        "2. Invoice numbers: INV-YYYYMM-NNN. Check that line items add up before proposing to send.",
        "3. Cash-flow analysis: monthly in/out, running balance, the three largest items, and a short risk note.",
        "4. Recurring billing: list which invoices are due this period and draft them; sending needs approval.",
        "5. Show money in the client's currency; Rupiah as Rp 1.234.567.",
      ].join("\n"),
      id: [
        "1. Gunakan tarif klien dan proyek dari master data; jangan mengarang angka.",
        "2. Nomor faktur: INV-YYYYMM-NNN. Pastikan rincian dijumlahkan dengan benar sebelum mengusulkan pengiriman.",
        "3. Analisis arus kas: masuk/keluar per bulan, saldo berjalan, tiga pos terbesar, dan catatan risiko singkat.",
        "4. Penagihan berulang: daftar faktur yang jatuh tempo periode ini dan buat drafnya; pengiriman memerlukan persetujuan.",
        "5. Tampilkan uang dalam mata uang klien; Rupiah sebagai Rp 1.234.567.",
      ].join("\n"),
    },
    subagents: [],
  },
  {
    key: "marketing",
    name: { en: "Marketing", id: "Pemasaran" },
    sop: {
      en: [
        "1. Research first: cite sources (web_fetch, knowledge base) and separate facts from assumptions.",
        "2. Copy: match the brand voice in the knowledge base; give 2-3 variants with a one-line rationale each.",
        "3. Pitch decks and proposals: problem, solution, proof, offer, next step; one idea per slide.",
        "4. Nothing is published or sent without approval.",
      ].join("\n"),
      id: [
        "1. Riset dulu: sebutkan sumber (web_fetch, basis pengetahuan) dan pisahkan fakta dari asumsi.",
        "2. Copywriting: sesuaikan dengan gaya bahasa merek di basis pengetahuan; berikan 2-3 variasi dengan alasan satu baris untuk masing-masing.",
        "3. Pitch deck dan proposal: masalah, solusi, bukti, penawaran, langkah berikutnya; satu ide per slide.",
        "4. Tidak ada yang diterbitkan atau dikirim tanpa persetujuan.",
      ].join("\n"),
    },
    subagents: [],
  },
];

export const DEPARTMENT_BY_KEY: Record<string, DepartmentDefinition> = Object.fromEntries(DEFAULT_DEPARTMENTS.map((d) => [d.key, d]));
