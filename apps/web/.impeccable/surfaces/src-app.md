---
version: 1
slug: "src-app"
primary_target: "src/app"
related_targets: []
---

# Surface brief: whole web app (Operate)

Seed key: 1a02dfdf (kind: pick — user chose "Papan Nama Ruko" on 2026-10-12 over the assigned Batik Tulis direction)

Scope and mode: every authenticated screen of apps/web (shell, Dasbor, Chat first; then the rest inherit the system). Mode: Operate.
Audience/job: Indonesian SME owner supervising AI employees; must see who is working, what waits for their approval, and act in one click. Secondary: managers, developers.
Constraints: Next.js 16 + Tailwind v4 + shadcn/Radix; next-intl id/en parity; a11y-labels test; WCAG 2.2 AA; prefers-reduced-motion; 44px targets on touch; existing light/dark toggle kept (dark is the default).

## Direction contract

THESIS: The office is literally lit. Every AI employee is an acrylic shop sign (papan nama ruko) on a night street: lit while working, a short flicker-on when a run starts, flickering while an incident is open, dark when idle or paused. The owner reads the whole office's state from across the street.

OWN-WORLD: Indonesian ruko row at night — backlit acrylic lightbox signs, condensed sign-painter capitals, warm asphalt dark, sodium spill under each lit sign. Not neon tubes, not glow edges: flat saturated acrylic with an inner luminance gradient and a soft offset light cast below.

STORY: Owner opens the app at night after closing the shop, sees which signs are lit, sees the amber "PERLU PERSETUJUAN" strip, approves in the chat, and the sign settles back to steady.

FIRST VIEWPORT (Chat): icon+label rail (left) · facade strip of employee signs across the top of the work area (team chat: the team's members; DM: that employee) · conversation list · thread with receipt chips and inline approval card headed by an amber lightbox strip · context panel (approvals queue, incidents, cost vs daily cap). FIRST VIEWPORT (Dasbor): facade of all employees as the hero row (the whole office), then approvals queue, incidents, today's activity, cost.

FORM: Type = Big Shoulders Display (sign capitals for headings, names on signs, big numbers) + Figtree (UI/body, tabular numerals). Palette = Full palette on a warm-dark ground: per-employee sign colour drawn from a fixed acrylic set (merah, kuning, tosca, biru, hijau, oranye, ungu, magenta), amber = needs approval, red = critical/incident text, tosca/green = done; the ground stays neutral warm-dark so the signs carry the colour. Density = medium-dense app. Controls = standard shadcn/Radix (buttons, tabs, inputs, selects) restyled in the world's radius/weights; never a costume.

SIGNATURE MOVE: the employee sign (`<EmployeeSign>`): lit / flicker-on (run start) / flicker (incident) / off (idle, paused) states, used in the facade strip, dashboard office row, and as the approval card header strip (amber). Reduced motion: no flicker, state shown by lit/unlit + text.

FINISH: acrylic inner gradient + 1px inner highlight + offset coloured light cast below lit signs; themed selection, caret, scrollbars, focus rings (kuning); tabular numerals; light mode = daytime street (signs unlit-but-coloured on cool concrete), same tokens.

Raises carried from the round: strict tonal ramp for grounds (g0–g3 only); every agent claim paired with its receipt; stable short refs on tasks/approvals where the data has them.

Unresolved: 3D office restyle (later pass); per-employee sign colour derivation (hash of id into the acrylic set unless the employee has a stored colour).
