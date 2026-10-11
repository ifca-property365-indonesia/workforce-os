# Additional instructions for Google Stitch — Workforce OS

Paste the block below into Stitch as the project's additional instructions / context (or as the first
message of the project), together with the repository's `DESIGN.md`. Every screen prompt in
[`STITCH-PROMPTS.md`](STITCH-PROMPTS.md) assumes this context.

---

```text
PROJECT CONTEXT — read before every screen

Product: Workforce OS, a self-hosted web app where a company "hires" AI employees and supervises them.
Each employee has a name, a role, a persona, memory, a set of tools and an autonomy level. Employees work
from chat, a task board, schedules (routines), webhooks and team briefs. Every irreversible action (send an
email, send an invoice, push code, post a webhook) stops at a human approval unless an Owner allow-listed it.
The product's promise: "Hire AI employees. Keep humans in charge." Its mental model: "where the work stops".

Design system: follow DESIGN.md (Signal & Ledger) exactly — its tokens, its three fonts (Fraunces for display,
IBM Plex Sans for UI, IBM Plex Mono for data), its single warm signal color, its hairline depth and its Do's and
Don'ts. If a request conflicts with DESIGN.md, DESIGN.md wins. Default to dark mode ("graphite"); provide the
light mode ("paper") when asked.

Users: operations leads, finance and support managers, agency owners and developers at Indonesian SMEs.
They are busy, skeptical of AI, and need to see what the AI did, what it will do, and what is waiting for them.
Primary devices: a laptop at work (1440×900) and a phone for approvals and chat (390×844).

Language: UI copy in Bahasa Indonesia (natural, short, sentence case). Use Rupiah (Rp 12.500.000), WIB times
(09.00), Indonesian dates (Sen, 13 Okt). Names: Pratama (Project Manager), Dewi (Developer), Fajar (Finance &
Billing), Sari (Customer Support), Budi (Sales). Clients: PT Sinar Properti, Graha Cempaka Residence,
Koperasi Maju Bersama. Team: "Delivery Squad" (Lead: Pratama).

Information architecture (left rail, grouped):
- Kerja: Dashboard, Obrolan (chat), Persetujuan (approvals, amber count), Papan tugas (Kanban), Rutinitas
- Tim: Karyawan (employees), Tim (teams), Kantor (live 2D/3D office)
- Data: Klien (clients & projects), Basis pengetahuan (knowledge base)
- Bottom: Pengaturan (settings), workspace switcher, account
Top status strip: live runs, credit/subscription meter, approvals count, kill switch (always visible).
Command palette on ⌘K.

Domain vocabulary (use these exact states):
- Task: QUEUED (Antre), RUNNING (Berjalan), AWAITING_APPROVAL (Menunggu persetujuan), DONE (Selesai),
  FAILED (Gagal), CANCELLED (Dibatalkan).
- Approval: PENDING (Menunggu), APPROVED, EXECUTING, EXECUTED (Terkirim/Dijalankan), REJECTED (Ditolak),
  FAILED (Gagal), EXPIRED (Kedaluwarsa).
- Autonomy: DRAFT (only drafts) → QUEUE (asks every time) → EXECUTE (asks every time, executes after) →
  CLOSE (runs allow-listed actions alone).
- Tools are shown in mono: send_email, draft_invoice, send_invoice, kb_search, web_fetch, delegate_subtask,
  git_push, create_pull_request, mcp:crm:list_contacts.
- Gate rules (why an action stopped or ran): reversible, allow_list, autonomy, taint, leak, dry_run, not_granted.
- Taint: content from outside (webhook payload, web page, imported skill, API client) is "untrusted"; it is
  shown with a hatch pattern and makes every irreversible action need approval.
- Incident: a task failed, stalled, looped or could not start; the team lead may retry or reassign, or a
  person is told ("needs you").
- Team responder modes: Ketua (lead answers), Semua (everyone in turn), Hanya yang disebut (mentions only),
  Otomatis (a fast model picks; shows "dipilih otomatis · 94%").

Hard rules (safety UI — never break):
1. Amber means a human decision is needed. Use it only for Approve, pending approvals, the kill switch,
   escalated incidents and the stop line. One amber focus per screen.
2. An approval always shows the exact payload (the email as it will be sent, the invoice PDF, the command),
   who asked, why it stopped (gate rule) and guard findings. Approve is never the only button: Ubah & setujui
   and Tolak are always present.
3. The kill switch is reachable from every screen in one click.
4. Untrusted content is always visibly marked (hatch + "tidak tepercaya" chip).
5. Numbers that cost money (credits, Rp, tokens) are in mono with tabular figures.

Motion & effects (make it feel alive, never busy):
- Procedural dot field on the canvas background (very low contrast) that ripples only around live runs.
- Streaming replies: a soft scanline caret and a live token/credit counter.
- Live status: a 1.6s breathing dot in live green on RUNNING; nothing moves when idle.
- Stop line: when an approval appears, the amber line draws left→right in 240ms.
- High-risk approvals (send_invoice, git_push): press-and-hold 600ms fills an amber ring; a keyboard path
  (Enter → confirm) always exists.
- View transitions between list and detail (task card → task inspector). Durations 150–300ms, ease-out,
  transform/opacity only. Everything respects prefers-reduced-motion.

Performance & responsiveness:
- Desktop 1440 and phone 390 for every key screen; tablet 1024 falls back gracefully.
- On phones the rail becomes a bottom bar: Obrolan, Persetujuan, Tugas, Kantor, Lainnya.
- No large images, no video backgrounds, no heavy blur. Skeletons match the final layout.

Implementation target (for exported code and annotations): Next.js 16 App Router, React 19, Tailwind CSS
v4 with CSS variables, shadcn/ui on Radix primitives, Lucide icons, next-intl (id/en), three.js only for the
office. Prefer semantic HTML, real <label> for every field, visible focus rings, 44px touch targets.

Avoid (AI-slop list): purple/blue gradients, gradient text, glassmorphism, glowing orbs, 3D blobs, stock
illustrations, emoji icons, icons in colored circles, four identical KPI cards, "Welcome back 👋", centered
hero + three feature cards, rounded-2xl on everything, shadows on every card, Inter/Roboto/Poppins,
lorem ipsum, fake charts without labels.
```

---

## Workflow that works best

1. **Create the project** in Stitch and connect this repository (already done). Make sure Stitch picks up
   `DESIGN.md` from the repository root; if it does not, paste the file's content as the design system.
2. **Paste the instructions above** as project context.
3. **Start with the master prompt** (`STITCH-PROMPTS.md` → 0). It designs the dashboard and locks the visual
   language. Iterate on it until it feels right before generating other screens — every later screen copies
   its decisions.
4. **One screen per prompt**, in the order of the prompts file. Generate the desktop version first, then ask
   for the phone version of chat and approvals.
5. **Run the anti-slop review prompt** (section R1) on each screen before accepting it.
6. **Light mode last**: once all dark screens are consistent, use prompt R4 to derive the paper versions.
7. **Hand-off**: export the screens (HTML/Tailwind or Figma) and share the link. The implementation maps
   DESIGN.md tokens onto `apps/web/src/app/globals.css` (shadcn CSS variables) and swaps Inter for the three
   fonts in `apps/web/src/app/layout.tsx`; components stay on shadcn/Radix so behaviour, accessibility tests
   and i18n keep working.

## What to check before accepting a screen

- [ ] Amber appears only where a person decides, and at most once as the focus.
- [ ] Fraunces only on the page title / headline sentence / empty state; numbers in Plex Mono.
- [ ] Real data (names, Rupiah, WIB, tool names), Indonesian copy that fits.
- [ ] Every approval shows payload, reason (gate rule), guard findings and three choices.
- [ ] Kill switch visible; untrusted content hatched.
- [ ] Works at 390px without horizontal scroll; touch targets ≥ 44px.
- [ ] Nothing from the avoid list.
