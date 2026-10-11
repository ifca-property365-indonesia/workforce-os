---
version: alpha
name: Workforce OS — Signal & Ledger
description: >-
  Design system for Workforce OS, a self-hosted platform for AI employees that people supervise. Every
  irreversible action stops at a human. The interface reads like an operations ledger lit by one warm signal:
  dark graphite by default, warm paper in light mode, editorial serif headlines, an industrial sans for the UI,
  and monospace wherever the data matters (credits, times, cron rules, ids).
colors:
  # Key colors (what generators read first): ink on graphite, a cool info accent, the single warm signal
  primary: "#ECEAE3"
  secondary: "#7CC7E8"
  tertiary: "#F2A93B"
  neutral: "#161714"
  # Dark mode, the default ("graphite")
  background: "#0E0F0D"
  surface: "#161714"
  surface-raised: "#1D1E1B"
  overlay: "#252622"
  line: "#2C2D29"
  line-strong: "#3A3B36"
  text: "#ECEAE3"
  text-muted: "#A3A197"
  text-faint: "#8A887E"
  # One warm signal: a human decision is needed (approvals, the kill switch, "needs you")
  signal: "#F2A93B"
  signal-ink: "#1A1305"
  signal-soft: "#3A2A10"
  # States
  live: "#7BD88F"
  live-soft: "#16301E"
  danger: "#FF6B4A"
  danger-soft: "#3A1710"
  info: "#7CC7E8"
  taint: "#E0B04A"
  # Light mode ("paper")
  light-background: "#F4F2EC"
  light-surface: "#FBFAF6"
  light-surface-raised: "#FFFFFF"
  light-line: "#E2DFD5"
  light-line-strong: "#CFCBBF"
  light-text: "#1A1A17"
  light-text-muted: "#5F5D55"
  light-signal: "#9A5B00"
  light-live: "#18753F"
  light-danger: "#C8371D"
  light-info: "#1C6E93"
typography:
  display-xl:
    fontFamily: Fraunces
    fontSize: 56px
    fontWeight: 480
    lineHeight: 1.04
    letterSpacing: -0.025em
    fontVariation: "'opsz' 96, 'SOFT' 30"
  display-lg:
    fontFamily: Fraunces
    fontSize: 40px
    fontWeight: 480
    lineHeight: 1.08
    letterSpacing: -0.02em
    fontVariation: "'opsz' 72, 'SOFT' 30"
  display-md:
    fontFamily: Fraunces
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: -0.01em
    fontVariation: "'opsz' 36, 'SOFT' 20"
  title:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.005em
  heading:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: IBM Plex Sans
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: IBM Plex Mono
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.08em
  data:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 450
    lineHeight: 1.4
    fontFeature: "'tnum' 1, 'zero' 1"
  data-lg:
    fontFamily: IBM Plex Mono
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: -0.02em
    fontFeature: "'tnum' 1"
rounded:
  none: 0px
  xs: 3px
  sm: 6px
  md: 10px
  pill: 999px
spacing:
  hair: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  4xl: 72px
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.background}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
    height: 36px
  button-primary-hover:
    backgroundColor: "#FFFFFF"
    textColor: "{colors.background}"
  button-signal:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
    height: 36px
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 32px
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 32px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
    height: 36px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 20px
  panel-raised:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 20px
  nav-item:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 8px 10px
    height: 34px
  nav-item-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  status-running:
    backgroundColor: "{colors.live-soft}"
    textColor: "{colors.live}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  status-waiting:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.signal}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  status-failed:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  status-done:
    backgroundColor: "{colors.overlay}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  chip-taint:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.taint}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: 2px 6px
  message-agent:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  message-user:
    backgroundColor: "{colors.overlay}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 10px 14px
  approval-card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 16px
  timeline-step:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    rounded: "{rounded.none}"
    padding: 8px 0px
  kbd:
    backgroundColor: "{colors.overlay}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: 1px 5px
  link:
    textColor: "{colors.info}"
    typography: "{typography.body-sm}"
  timestamp:
    textColor: "{colors.text-faint}"
    typography: "{typography.data}"
  divider:
    backgroundColor: "{colors.line}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.line-strong}"
    height: 1px
  rail:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-sm}"
    width: 248px
  # Light mode ("paper") counterparts
  page-light:
    backgroundColor: "{colors.light-background}"
    textColor: "{colors.light-text}"
  panel-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
    padding: 20px
  panel-raised-light:
    backgroundColor: "{colors.light-surface-raised}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
    padding: 20px
  button-primary-light:
    backgroundColor: "{colors.light-text}"
    textColor: "{colors.light-background}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
    height: 36px
  button-signal-light:
    backgroundColor: "{colors.light-signal}"
    textColor: "{colors.light-surface-raised}"
    typography: "{typography.heading}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
    height: 36px
  text-muted-light:
    textColor: "{colors.light-text-muted}"
    typography: "{typography.body-sm}"
  status-running-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-live}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  status-failed-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-danger}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 3px 8px
  link-light:
    textColor: "{colors.light-info}"
    typography: "{typography.body-sm}"
  divider-light:
    backgroundColor: "{colors.light-line}"
    height: 1px
  divider-strong-light:
    backgroundColor: "{colors.light-line-strong}"
    height: 1px
---

# Workforce OS — Signal & Ledger

## Overview

Workforce OS is where a company hires AI employees (each with a name, role, persona, memory, tools and an
autonomy level), gives them work in chat, on a task board or on a schedule, and **stays in charge**: every
irreversible action (send an email, send an invoice, push code, call a webhook) stops at a human approval.

The interface is an **operations ledger lit by one warm signal**.

- **Ledger**: work is a sequence of precise, timestamped entries. The layout is calm, dense and honest:
  monospace for anything measured (credits, tokens, times, cron rules, ids), hairline rules instead of heavy
  cards, aligned columns, no decoration that carries no information.
- **Signal**: there is exactly one warm color, amber. It appears only where a **person** is needed: a pending
  approval, the kill switch, an escalated incident, "needs you". If amber is on screen, something is waiting
  for a human. Everything else is graphite, paper and quiet state colors.
- **Editorial voice**: page titles and empty states use a soft optical serif (Fraunces) so the product feels
  written by people for people, not generated. The UI itself is IBM Plex Sans; numbers are IBM Plex Mono.
- **Alive, not busy**: employees are working while you look. Motion shows real activity (a run streaming, a
  queue draining, a routine firing) and stops when nothing happens. Idle screens are still.

Audience: operations leads, finance and support managers, agency owners and developers at small and
mid-size companies in Indonesia and the region. The default UI language is Bahasa Indonesia (English is
equal). Money is Rupiah (`Rp 12.500.000`), time zone Asia/Jakarta.

Brand words: **trustworthy, precise, calm, warm, alive, Indonesian-made**. Never: playful-cute, neon, "magic",
futuristic-chrome, crypto.

## Colors

Dark mode ("graphite") is the default; light mode ("paper") is a first-class equal, not an afterthought.
Both are defined in the tokens above (`light-*` for paper).

- **Neutrals carry a warm undertone** (graphite and paper, not blue-slate). Surfaces step up in small
  increments: `background` → `surface` → `surface-raised` → `overlay`. Separation comes from `line`
  hairlines (1px), not shadows.
- **Signal amber** (`signal`, light `light-signal`) is reserved for human decisions: Approve buttons, pending
  approval badges, the approvals count, the kill switch, "needs you" on incidents, the stop line in timelines.
  Never use it for decoration, links, charts or marketing emphasis. One amber focus per view.
- **Live green** (`live`) means a run is in progress right now (streaming reply, running task). It pulses
  softly; it is never used for "success" decoration.
- **Danger vermilion** (`danger`) means failed, rejected, blocked, destructive.
- **Info cyan** (`info`) is for links and neutral information only, sparingly.
- **Taint** (`taint`) marks untrusted content (webhook payloads, web pages, imported skills, machine-client
  messages). It is always paired with a diagonal hatch pattern (see Shapes) so it is distinguishable from
  signal amber without relying on hue.
- Charts use the neutral ramp plus at most one state color; per-employee series use desaturated tints of the
  neutrals with direct labels, never a rainbow.
- Text contrast: `text` on `background` and `light-text` on `light-background` exceed WCAG AAA for body text;
  `text-muted` stays above 4.5:1. Never put body text in `text-faint`.

## Typography

Three families from Google Fonts, each with one job:

- **Fraunces** (variable, `opsz` + `SOFT` axes) for display only: page titles, the dashboard headline
  sentence, empty states, the login statement. Weight around 480, tight tracking, soft optical size. Never
  for UI controls, tables or body copy. Italic is allowed for one emphasized word in a headline.
- **IBM Plex Sans** for the interface: navigation, buttons, forms, chat messages, descriptions. 15px body,
  13px secondary. Sentence case everywhere ("Buat tugas", not "BUAT TUGAS" or "Buat Tugas").
- **IBM Plex Mono** for anything measured or machine-like: credits, Rupiah amounts in tables, token counts,
  latency, timestamps, cron expressions, ids, tool names (`send_email`), keyboard hints. Tabular numerals and
  slashed zero always on. The `label` style (11px, uppercase, 0.08em tracking) titles sections and table
  headers — the ledger's column heads.

Hierarchy is built with size, weight and the serif/sans/mono switch, not with color. Maximum line length 72
characters for prose. Indonesian strings run ~20% longer than English: never design a control that only
fits the English word.

## Layout

- **8px grid**, with 4px for tight data. Desktop content uses a 12-column grid with 24px gutters; dense
  views (tables, timelines, inbox) use the full width; prose and forms cap at 720px.
- **App shell**: a left rail (248px expanded, 64px collapsed, icons + labels) with sections Kerja (Dashboard,
  Obrolan, Persetujuan, Papan tugas, Rutinitas), Tim (Karyawan, Tim, Kantor), Data (Klien, Basis
  pengetahuan), and Pengaturan at the bottom with the workspace switcher. A thin top **status strip** (40px)
  shows live runs ("2 berjalan"), the subscription/credit meter, the approvals count in amber and the kill
  switch. Demo mode is a hatched band inside the strip, not a purple banner.
- **Command palette** (⌘K / Ctrl K) is the primary way to jump: employees, tasks, conversations, settings,
  actions ("Brief tim Delivery", "Jalankan rutinitas…").
- **Signature layouts**:
  - *Ledger timeline* (task inspector, activity): a vertical spine with monospaced timestamps on the left
    and entries on the right; LLM calls, tool calls, guard hits and approvals as rows; an approval is a
    horizontal amber **stop line** that crosses the spine with the decision on it.
  - *Split work view* (chat, approvals): list on the left, the thread or payload in the center, a context
    rail on the right (who is answering, routing, taint, budget, linked task).
  - *Operations floor* (dashboard): one editorial headline sentence that states the situation ("Tiga karyawan
    sedang bekerja. Satu tindakan menunggu Anda."), then the live roster, the approval queue and spend —
    not a row of four identical stat cards.
- **Responsive**: designed mobile-first for the two things people do on a phone — approve and chat. Below
  768px the rail becomes a bottom bar (Obrolan, Persetujuan, Tugas, Kantor, Lainnya); split views become
  stacked screens with a back affordance; tables become ledger lists. Nothing scrolls horizontally except
  tab rails and code.
- **Speed is a layout rule**: skeletons match the final layout exactly, content never jumps, the first view
  of every page is useful within 1 second on a mid-range phone.

## Elevation & Depth

Depth comes from **tone and hairlines, not drop shadows**.

- Level 0 `background`: the canvas, with an optional procedural dot field (see Do's) at 4% opacity.
- Level 1 `surface` + 1px `line`: panels, list rows, chat bubbles.
- Level 2 `surface-raised` + 1px `line-strong`: popovers, the inline approval card, dialogs.
- Level 3 `overlay`: menus, command palette, toasts, with a single soft shadow (0 8px 24px rgba(0,0,0,.35)
  in dark, rgba(26,26,23,.10) in light) — the only shadow in the system.
- Focus is a 2px ring in `info` (or `signal` on signal buttons) with 2px offset; never a glow.
- Modals dim the page to 60% `background`; no blur, no glass.

## Shapes

- Radii are small and purposeful: `xs` 3px for chips and kbd, `sm` 6px for buttons and inputs, `md` 10px for
  panels and cards, `pill` only for status badges and avatars. Tables, timelines and dividers are square.
- **Hatch pattern** (45° stripes, 1px every 6px, in `taint` at 30%) marks untrusted content and demo mode.
  It is the only pattern in the system.
- **The stop line**: a 1px amber rule with a small notch (a 6px diamond) where a person decides. Used in
  timelines, on approval cards (top edge) and in the dashboard approval queue.
- Icons: Lucide, 1.5px stroke, 16px in UI and 20px in navigation, never filled, never in colored circles.
  Employee avatars are the only illustrations: the chibi office characters or a monogram on a tinted square.
- Dividers are hairlines; never use 2px+ borders except the signal stop line and the active nav marker (a
  2px vertical bar in `text`).

## Components

- **Buttons**: `button-primary` is inverted (paper on graphite) for the main action of a view;
  `button-signal` (amber) exists only for Approve and for confirming a human decision; `button-ghost` for
  secondary actions; `button-danger` for reject/delete. One primary per view. Labels are verbs ("Setujui &
  kirim", "Tolak dengan masukan"), never "OK"/"Submit".
- **Inputs**: label above (always a real, associated label), hint below in `body-sm` `text-muted`, error below
  in `danger`. Monospace inputs for cron, domains and selectors (`mcp:crm:list_*`), with a live preview
  line under them (e.g. cron → "Pada 09:00, Senin sampai Jumat · berikutnya Sen 13 Okt 09.00").
- **Status badges**: `status-running` (pulsing dot), `status-waiting` (amber), `status-failed`,
  `status-done`; label-style mono uppercase text, short words ("BERJALAN", "MENUNGGU ANDA").
- **Chat**: agent messages left with the employee's avatar, name and role; user messages right in
  `message-user`; routing shown as a quiet mono note ("dipilih otomatis · 94%"); approvals render **inline**
  as an `approval-card` attached under the message that raised it, with the amber stop line on its top edge,
  the exact payload (email as it will be sent), guard findings, and Setujui / Ubah & setujui / Tolak.
  Receipts after a decision are a single centered mono line. Versions (edit/regenerate) show "‹ 2/3 ›" in mono.
  `@mention` autocomplete is a compact list with avatar, name and role.
- **Approval inbox**: a ledger list (time, employee, tool in mono, title, risk) with a large payload preview;
  keyboard: J/K to move, A approve, R reject, E edit. On mobile each approval is a full-screen card with the
  payload first and the two decision buttons fixed at the bottom.
- **Tables**: sticky mono header row in `label`, 44px rows, right-aligned tabular numbers, zebra off,
  row hover = `surface-raised`.
- **Timeline / inspector**: see Layout; each step shows kind, name in mono, model, tokens, latency, credits;
  failed steps carry a vermilion left tick; the gate rule ("allow_list", "taint") is a mono chip.
- **Office**: the 2D/3D office stays the playful exception — keep it inside a framed panel with the ledger
  list of "who is doing what" beside it.
- **Empty states**: one Fraunces sentence, one line of guidance, one action. No illustrations, no emoji.
- **Toasts**: bottom-right (bottom on mobile), mono timestamp, max one line + action.

## Do's and Don'ts

Do:
- Use real, specific data in every design: employees Pratama (Project Manager), Dewi (Developer), Fajar
  (Finance & Billing); clients PT Sinar Properti, Graha Cempaka Residence; amounts like Rp 12.500.000;
  tools like `send_email`, `draft_invoice`; times in WIB.
- Let amber mean exactly one thing: a human decision. Count the amber on every screen; if it is more than one
  focus, remove some.
- Show the system thinking honestly: tokens, credits, latency, the gate rule that decided, the taint mark.
- Use procedural motion that encodes activity: a dot field that ripples only where a run is live; a caret
  scanline on a streaming reply; a ticking credit counter; a 600ms fill on press-and-hold for high-risk
  approvals (always with a keyboard/confirm alternative). All motion uses transform/opacity, 150–300ms
  ease-out, and stops under `prefers-reduced-motion`.
- Use View Transitions for page and tab changes (task card → task page, approval row → approval detail).
- Design both graphite and paper for every screen, and the 390px phone layout for chat and approvals.
- Keep Indonesian copy natural and short: "Menunggu Anda", "Setujui & kirim", "Jalankan sekarang".

Don't:
- No purple/blue gradients, gradient text, glowing orbs, glassmorphism, frosted panels or aurora blobs.
- No hero section with three feature cards, no "Welcome back 👋", no stock illustrations, no 3D blobs.
- No emoji as icons, no icons in colored circles, no rounded-2xl-everything, no shadows on every card.
- No four identical KPI tiles as the top of the dashboard; no charts without labels; no rainbow series.
- No Inter, Roboto, Poppins or Space Grotesk. No all-caps buttons. No centered body text.
- Don't use amber for links, charts, highlights or marketing; don't use green for decoration.
- Don't hide the safety model: never make Approve the only visible button, never auto-collapse guard
  findings that are high severity, never show a payload truncated without a way to read it all.
- Don't animate idle screens; no parallax, no confetti, no typewriter effects on static text.
