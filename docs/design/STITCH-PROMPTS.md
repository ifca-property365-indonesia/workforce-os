# Google Stitch prompts — Workforce OS

Use with `DESIGN.md` (repository root) and the project context in
[`STITCH-INSTRUCTIONS.md`](STITCH-INSTRUCTIONS.md). One prompt per screen, in this order. Prompt 0 locks the
visual language; iterate on it until it is right, then every other prompt says "same system as the
dashboard". Copy each block as-is.

---

## 0. Master prompt — Dashboard ("operations floor"), desktop 1440 × 900, dark

```text
Design the Dashboard of Workforce OS, a web app where a company supervises its AI employees. Follow DESIGN.md
"Signal & Ledger" exactly: graphite dark mode, warm paper text, ONE warm amber signal used only where a human
must decide, hairline borders instead of shadows, Fraunces for the headline, IBM Plex Sans for UI, IBM Plex
Mono for every number. Bahasa Indonesia copy.

Layout: left rail 248px (groups "Kerja", "Tim", "Data"; items Dashboard, Obrolan, Persetujuan with an amber
count "2", Papan tugas, Rutinitas, Karyawan, Tim, Kantor, Klien, Basis pengetahuan; Pengaturan and the
workspace "Graha Digital Agency" at the bottom). A 40px top status strip: "● 2 berjalan" (live green dot),
a credit meter "1.240 / 5.000 kredit · Okt" in mono, "2 menunggu Anda" in amber, a small outlined
"Kill switch" button, ⌘K hint, avatar.

Content, top to bottom (asymmetric, not four KPI cards):
1. A Fraunces headline sentence at 40px: "Tiga karyawan sedang bekerja. Dua tindakan menunggu Anda." with
   a mono subline "Sen, 13 Okt · 10.42 WIB · 14 tugas selesai minggu ini".
2. A two-column row. Left (8 cols): "Lantai kerja" — a live roster as a ledger list: avatar, name, role,
   current activity in plain words ("Dewi — menulis perbaikan export CSV · 3 mnt"), status badge
   (BERJALAN breathing green / MENUNGGU ANDA amber / SIAGA muted), credits today in mono right-aligned.
   Right (4 cols): "Menunggu Anda" — the approval queue as compact rows, each with the amber stop line on
   its left edge: "Fajar · send_invoice · INV-2026-0142 · Rp 12.500.000 · PT Sinar Properti", "Sari ·
   send_email · Balasan komplain unit 12B · Graha Cempaka Residence"; a ghost button "Buka kotak masuk".
3. A full-width "Pengeluaran 8 minggu" chart: thin stacked bars per week in neutral tints with direct labels
   (Pratama, Dewi, Fajar), the budget as a dashed hairline, totals in mono. Beside it "Insiden" with one row
   "Gagal · tugas Laporan mingguan · SMTP tidak terjangkau · perlu Anda" and "2 diselesaikan 7 hari ini".
4. A quiet footer row: "Rutinitas berikutnya: Laporan status klien · Sen 09.00" and "Kantor →".

Effects: a barely visible procedural dot grid on the background that ripples softly around the two working
employees; the BERJALAN dots breathe; the amber stop lines are drawn. Nothing else moves.
Avoid gradients, glass, glowing elements, emoji, illustrations, icons in circles, identical KPI cards.
```

---

## 1. Sign in — desktop 1440 and phone 390

```text
Same system as the dashboard. Design the sign-in page. Split layout: left 55% is an editorial statement on
graphite — Fraunces 56px "Pekerjaan berhenti di tempat Anda memutuskan." with a mono caption "Workforce OS ·
self-hosted · didukung Claude Agent SDK", and below it a live, procedural "ledger" illustration made only of
typography and hairlines: five mono log lines appear one by one ("10.42.07  Fajar  draft_invoice  ✓",
"10.42.11  Fajar  send_invoice  ◆ menunggu persetujuan") with the amber stop line drawn under the last one.
Right 45%: a narrow form on paper-toned surface: Email, Kata sandi (real labels), primary button "Masuk"
(inverted ink), "Masuk dengan Google" ghost button, small text "Akun dibuat oleh admin workspace.",
language switch "ID / EN" top right. Phone: the statement shrinks to 32px above the form; the log keeps
three lines. No gradient, no purple, no glass.
```

## 2. Chat — team conversation with an inline approval, desktop 1440

```text
Same system as the dashboard. Design the "Obrolan" (chat) screen as a three-pane split work view.
Left pane 280px: "Chat baru" button and quick starts (avatars Pratama, Dewi, Fajar, "Delivery Squad"),
then a conversation list with title, participants and mono relative time; the active one highlighted with a
2px ink bar.
Center: thread of the team "Delivery Squad". Header: team name, mono note "dijawab oleh: Ketua (Pratama)",
a segmented control for the responder mode (Ketua / Semua / Disebut / Otomatis).
Messages: user message right ("@Fajar tolong kirim invoice Oktober ke PT Sinar Properti"); agent replies left
with avatar, name, role and a quiet mono routing note "disebut". Fajar's reply explains the invoice, then an
INLINE APPROVAL CARD attached under it: amber stop line on its top edge, title "Kirim invoice INV-2026-0142",
mono tool "send_invoice", gate reason chip "autonomy · QUEUE", a rendered invoice preview (client, 3 line
items, PPN 11%, total Rp 12.500.000 in mono), a collapsed "Temuan pengaman · 1 (sedang)" row, and three
buttons: amber "Setujui & kirim", ghost "Ubah & setujui", danger "Tolak". Below, a centered mono receipt line
from an earlier decision: "✓ Email ke budi@sinarproperti.co.id terkirim · 09.58".
A streaming reply from Dewi at the bottom with a soft scanline caret and a live counter "1.204 token · 0,9
kredit". Version switcher "‹ 2/2 ›" on an edited message.
Composer: multiline input "Pesan (ketik @ untuk menyebut seseorang)", attach button, send; an open @mention
popover listing Pratama / Dewi / Fajar / @semua with roles.
Right rail 300px "Konteks": who may answer, autonomy per member, today's credits, linked task "Invoice
Oktober — Menunggu persetujuan", and a hatched "tidak tepercaya" notice when the thread contains external
content.
```

## 3. Chat — phone 390 × 844

```text
Same chat, phone layout. Bottom tab bar (Obrolan active, Persetujuan with amber "2", Tugas, Kantor, Lainnya).
Top: back arrow, "Delivery Squad", responder mode as a small mono chip. The inline approval card fills the
width: payload first (invoice summary and total), then the three decision buttons stacked full width with
44px height, amber first. The composer sticks above the keyboard area. No horizontal scrolling anywhere.
```

## 4. Approvals inbox — desktop 1440

```text
Same system. Design "Persetujuan", the approvals inbox. Tabs in mono labels: MENUNGGU 3 · DISETUJUI ·
DITOLAK & KEDALUWARSA. Left (5 cols): a ledger list, each row = time (mono), employee avatar+name, tool
(mono), title, client, risk marker; the selected row has the amber stop line. Keyboard hints at the bottom:
J/K pindah · A setujui · R tolak · E ubah (kbd chips).
Right (7 cols): the selected approval in full: header "Fajar ingin mengirim invoice", why it stopped
("Tindakan permanen membutuhkan persetujuan · aturan: autonomy"), the exact email as it will be sent (To,
Subject, body, attachment INV-2026-0142.pdf with an inline PDF preview), "Temuan pengaman" expanded with one
medium finding (NIK di lampiran, redacted), the run it came from ("dari tugas Invoice Oktober · lihat
jejak"), and the decision bar: amber "Setujui & kirim" (press-and-hold ring for invoices), "Ubah & setujui",
"Tolak dengan masukan" with a feedback textarea that says "Masukan disimpan ke memori Fajar".
One row in the list is hatched "tidak tepercaya" because it came from a webhook.
```

## 5. Approvals — phone 390

```text
Same inbox on a phone: a stack of full-screen cards, one approval at a time, swipe-free. Card: employee, tool
(mono), title, payload preview first, reason chip, findings, then the fixed bottom bar with "Tolak" and an
amber "Setujui" (hold to confirm for invoices). A small "1 dari 3" mono counter at the top.
```

## 6. Task board — desktop 1440

```text
Same system. "Papan tugas" Kanban with columns ANTRE, BERJALAN, MENUNGGU PERSETUJUAN, SELESAI, GAGAL
(mono column heads with counts). Cards are compact ledger entries: title, assignee avatar, client, source
chip (chat / rutinitas / webhook / tim), credits so far in mono, time; running cards have the breathing dot;
cards waiting for approval have the amber stop line on top; one failed card shows "Insiden · dicoba ulang
1/2". A filter bar: Karyawan, Klien, Proyek, search, "Tugas baru" primary button. One card is a team parent
task with three subtasks shown as a thin progress segment.
```

## 7. Task inspector — the ledger timeline, desktop 1440

```text
Same system. Design the task page "Invoice Oktober — PT Sinar Properti". Header: status badge MENUNGGU
PERSETUJUAN, assignee Fajar, source "rutinitas · Laporan bulanan", total credits "3,42 kredit" and tokens in
mono, actions (Jalankan ulang, Dry run, Batalkan).
Tabs: Jejak (active) · Hasil · Kode.
The Jejak tab is the signature ledger timeline: a vertical spine; left column mono timestamps (10.41.58,
10.42.03…); right column entries: "LLM · claude-opus-5-5 · 2.104 → 386 token · 1,2 dtk · 0,8 kredit",
"TOOL · kb_search · 'tarif PPN' · ✓", "TOOL · draft_invoice · INV-2026-0142 · ✓", "GATE · send_invoice ·
autonomy → persetujuan", then a full-width horizontal AMBER STOP LINE crossing the spine with a diamond
notch and the pending approval summary on it ("Menunggu Anda · Setujui di sini"). One earlier entry is a
guard hit "PENGAMAN · input · injeksi terdeteksi di hasil web_fetch → run ditandai tidak tepercaya" with the
hatch. Entries expand to show JSON input/output in mono. A right rail shows the brief, deliverables and
"Mengapa berhenti?" explained in one sentence.
```

## 8. Employees — list and profile, desktop 1440

```text
Same system. Two screens.
(a) "Karyawan": a dense table (not cards): avatar (chibi character head), name, role, department, autonomy
(DRAFT/QUEUE/EXECUTE/CLOSE as a 4-step mono scale), model, today's credits vs daily budget as a thin bar,
status. Primary "Rekrut karyawan".
(b) Profile of "Fajar · Finance & Billing": header with a larger chibi avatar, Fraunces name, role, autonomy
QUEUE, status, actions (Obrolan, Jeda, Ekspor). Tabs: Ringkasan · Instruksi & replay · Alat & otonomi ·
Memori · Aktivitas. Show the Aktivitas tab: plain-language receipts in a ledger ("Mengirim email ke
budi@sinarproperti.co.id — terkirim", "Membuat draft invoice INV-2026-0142", "Diminta persetujuan:
send_invoice"), each with mono time and a link to its task, paging "Aktivitas lebih lama".
```

## 9. Hire wizard — desktop 1440

```text
Same system. "Rekrut karyawan" as a four-step wizard with a mono step rail (01 Templat · 02 Persona &
konteks · 03 Alat & otonomi · 04 Tugas pertama). Show step 03: a grid of tools grouped by category with
reversible/irreversible marks (irreversible tools carry a tiny amber diamond), an autonomy control as a
4-stop track DRAFT → QUEUE → EXECUTE → CLOSE with one sentence explaining what changes at each stop, and a
live preview on the right: "Fajar akan meminta persetujuan Anda sebelum mengirim email atau invoice."
```

## 10. Teams — desktop 1440

```text
Same system. "Tim": left list of employees (draggable), right the team "Delivery Squad" with member chips
(lead crowned with a thin ink crown icon), the responder mode as four selectable rows with one-line
explanations (Ketua / Semua / Hanya yang disebut / Otomatis — "model cepat memilih; jika ragu, Ketua"),
actions Brief tim, Ekspor, Impor. Show a team brief in progress: Pratama's plan with three subtasks and their
states in a compact timeline.
```

## 11. Routines with the new-routine dialog — desktop 1440

```text
Same system. "Rutinitas" list (name, cron in mono "0 9 * * 1", human label "Setiap Senin 09.00", next run,
last run status, enable switch, Jalankan sekarang). Open dialog "Rutinitas baru": Nama; Cron (mono input)
with a live preview line under it "Pada 09.00, Senin sampai Jumat · berikutnya Sen 13 Okt 09.00 · Sel 14 Okt
09.00 · Rab 15 Okt 09.00"; Zona waktu; Ditugaskan ke; "Jika eksekusi sebelumnya masih berjalan" as two radio
rows (Lewati / Antrekan); brief template; switches Satu tugas per klien · Dry run · Aktif. Also show the
error state for a 6-field cron in danger text.
```

## 12. Office — desktop 1440

```text
Same system. "Kantor": a framed panel (radius md, hairline) containing the existing live 2D/3D office (keep
it playful but muted: warm low-poly room, characters at desks), and beside it a ledger list "Siapa
mengerjakan apa" (Dewi — menulis kode · 3 mnt; Fajar — menunggu persetujuan ◆; Pratama — merencanakan brief
tim). Toggle 2D / 3D in mono. The rest of the page stays as quiet as every other screen.
```

## 13. Settings — integrations, webhooks, API access, skills, desktop 1440

```text
Same system. "Pengaturan" with a horizontal tab rail in mono (UMUM · EMAIL · NOTIFIKASI · INTEGRASI ·
REPOSITORI · DEPARTEMEN · SKILL · HARGA · ANGGOTA · WEBHOOK · AKSES API · LOG AUDIT) that scrolls on small
screens. Show four panels stacked as separate artboards:
- Integrasi: MCP servers (name, URL in mono, auth "OAuth" chip, "Tes koneksi" result "Terhubung · 14 alat
  (9 reversibel)"), "Hubungkan dengan OAuth".
- Webhook: one trigger with URL + copy, target employee, delivery log (mono time, status, "duplikat"), the
  one-time secret reveal state with a warning that it is shown once.
- Akses API: personal tokens table (name, prefix wfos_ab12…, expires, last used), the `claude mcp add …`
  command in a mono block with copy.
- Skill: list of SKILL.md skills with source badges (ditulis di sini / dipelajari / impor — hatched), an
  editor split view (SKILL.md text left, parsed preview right with byte counter).
```

## 14. Command palette and empty states

```text
Same system. (a) The ⌘K command palette over the dashboard: search field, groups "Lompat ke" (Fajar, Tugas
Invoice Oktober, Obrolan Delivery Squad), "Tindakan" (Brief tim Delivery, Jalankan rutinitas Laporan
status, Aktifkan kill switch — this one in amber text), kbd hints, recent items. (b) Three empty states, each
a single Fraunces sentence + one line + one action: "Belum ada yang menunggu Anda." (Persetujuan),
"Belum ada tugas hari ini." (Papan tugas), "Rekrut karyawan pertama Anda." (Karyawan). No illustrations.
```

---

## Refinement prompts

### R1. Anti-slop review (run on every screen)

```text
Review this screen against DESIGN.md and fix every violation without asking: count the amber elements and
keep only the ones where a person decides (one focus); remove any gradient, glow, glass, blur, emoji icon,
icon-in-circle, illustration, decorative shadow or rounded-2xl; make every number IBM Plex Mono with
tabular figures; make sure Fraunces appears only in the headline/title/empty state; replace any generic or
lorem text with the Indonesian sample data from the project context; make the safety information visible
(payload, gate reason, guard findings, three decision buttons, kill switch). Then list what you changed.
```

### R2. Motion and interaction annotation

```text
Annotate this screen for developers with the motion spec from DESIGN.md: which elements move, trigger,
duration (150–300ms), easing (ease-out), transform/opacity only, the reduced-motion fallback, and the
keyboard path for every pointer interaction (including press-and-hold approve). Keep idle states still.
```

### R3. Responsive pass

```text
Produce the 390 × 844 phone version of this screen: bottom tab bar (Obrolan, Persetujuan, Tugas, Kantor,
Lainnya), stacked panes with back navigation, tables turned into ledger lists, 44px touch targets, no
horizontal scroll except the tab rail, primary actions in a fixed bottom bar.
```

### R4. Light mode ("paper")

```text
Create the light mode of this exact screen using the light-* tokens in DESIGN.md: warm paper background,
ink text, the darker amber light-signal, same hairlines and layout. Keep every contrast at WCAG AA or better.
Do not invert the chibi avatars or the office render.
```

### R5. Consistency pass across screens

```text
Compare all screens in this project and make them consistent: identical rail and status strip, the same
tab style, the same badge vocabulary (BERJALAN, MENUNGGU ANDA, SELESAI, GAGAL), the same approval card, the
same mono timestamp format (10.42 WIB / Sen 13 Okt), the same button hierarchy (one primary per view, amber
only for decisions). Report the differences you fixed.
```

### R6. Hand-off

```text
Export this screen as clean semantic HTML with Tailwind CSS v4 classes that reference CSS variables named
after the DESIGN.md tokens (--background, --surface, --surface-raised, --line, --text, --text-muted,
--signal, --live, --danger, --info, --taint), Lucide icons, real <label> elements, and no inline styles.
List any new component you introduced that is not in DESIGN.md.
```
