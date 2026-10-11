# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary user: a business owner who wants to "hire" AI employees for roles they would otherwise staff or juggle themselves — operations manager, finance and billing, CTO/developer, support, sales. Secondary users are the people who work alongside those employees day to day: managers who brief, approve and review, and developers who use Workspace mode (code, diffs, pushes). The shared job is to get real work done more easily, more autonomously and with fewer human errors, while staying in control. (Confirmed 2026-10-12.)

## Product Purpose
Workforce OS lets a company run a team of AI employees. Each one has a name, a role, a persona, memory, tools and an autonomy level. They take work from chat, a task board, schedules (routines), webhooks and team briefs, and they work together in teams. Success means the owner hands off recurring work and only steps in for decisions: approvals, rejections with feedback, and incidents.

## Positioning
A living AI office. It is chat-first like GrokBot and OpenMausBot: talk to employees and teams. It adds an optional visualization of the office as a live 3D space (KayKit low-poly assets by Kay Lousberg) where every employee is a character whose activity shows what it is doing right now. Under the office sits a safety model that neighbours lack: every irreversible action (send email, send invoice, push code, call a webhook) stops at a human approval unless an Owner allow-listed it, and untrusted input "taints" a run so that even allow-listed actions need a person. (Positioning confirmed by the user; the safety mechanism is product fact from the codebase.)

## Operating Context
- Self-hosted on a VPS (Next.js web app plus a BullMQ worker; PostgreSQL, Redis).
- Used on a laptop during work and on a phone for approvals and chat. The PWA has push and Telegram notifications, including approve/reject.
- Workflows: 1:1 and team chat (responder modes: lead, everyone, mentions, automatic routing); a task board with an activity inspector (every LLM/tool step with tokens, credits and latency); routines (cron); an approvals inbox and approval cards inline in chat; incidents with lead retry/reassign; packages export/import; webhooks; MCP integrations and the platform's own MCP server; skills; a per-employee memory journal.
- Billing unit: credits (1 credit = $0.01), with daily and monthly budgets, a Claude subscription meter and a kill switch.

## Capabilities and Constraints
- Stack (existing): Next.js 16 App Router, React 19, Tailwind CSS v4, shadcn/ui on Radix, Lucide, next-intl (id/en), three.js for the office.
- UI tests that must keep passing: i18n catalog parity (no hard-coded strings), form labels associated with fields, typecheck and lint.
- Terminology: karyawan (employee), tugas (task), persetujuan (approval), rutinitas (routine), tim, kantor (office), insiden, kredit.
- Undecided (inferred, delegated to design): which screens get the 3D office beyond `/office`; whether chat or the office is the home screen.

## Brand Commitments
- Name: Workforce OS (inferred to be kept; no formal logo exists yet).
- Employees are characters: customizable chibi looks (skin, hair, beard, glasses, headwear, shirt, company badge), and KayKit low-poly 3D office assets (CC0) in `apps/web/public/office`.
- Default language Bahasa Indonesia, English equal; money in Rupiah; time zone Asia/Jakarta. (Inferred from the product; delegated.)
- Visual identity is delegated to design. A previous restrained direction (warm graphite/paper, a single amber accent, an editorial serif, hairlines, minimal motion) was rejected as too basic and stiff.

## Evidence on Hand
- The product itself with demo data (Demo Mode, seeded employees Pratama/Dewi/Fajar, team "Delivery Squad").
- Office assets in `apps/web/public/office`. QA screenshots of the current UI in `/opt/wfos-qa/shots` (not in the repo).
- No customer testimonials, logos, metrics or case studies exist. Do not fabricate them.

## Product Principles
1. Work happens without you; decisions wait for you. Irreversible actions always reach a person in one obvious place.
2. The office is alive. You can see who is working on what, right now, without reading logs.
3. Nothing hidden. Every action can be traced to its steps, cost and the rule that let it run or stopped it.
4. Fewer human errors. Defaults are safe, the payload shown is exactly what will be sent, and edits are possible before approving.
5. Indonesian-first, owner-friendly. Plain language over jargon; technical depth is one click away for developers.

## Accessibility & Inclusion
WCAG 2.2 AA: contrast, associated labels and keyboard paths for every action, including approvals. Respect `prefers-reduced-motion`, keeping the 3D office and effects optional and pausable. 44px touch targets on phones.
