---
name: Workforce OS
description: A living AI office, read like a row of lit shop signs at night.
colors:
  background: "#110e15"
  card: "#18141d"
  popover: "#1e1924"
  secondary: "#211b27"
  accent: "#2a2231"
  border: "#2f2737"
  input: "#3a3043"
  foreground: "#f7efe6"
  muted-foreground: "#b3a7b9"
  primary: "#fff3e4"
  primary-foreground: "#17121c"
  destructive: "#ff5a4c"
  success: "#3fd0a0"
  ring: "#f6b51e"
  sign-off-panel: "#1d1922"
  sign-off-edge: "#2c2533"
  day-background: "#f3f1f4"
  day-card: "#ffffff"
  day-secondary: "#e9e5ec"
  day-muted: "#ebe7ee"
  day-accent: "#e4dfe8"
  day-border: "#dcd5e0"
  day-input: "#d3cbd8"
  day-foreground: "#1b1620"
  day-muted-foreground: "#5c5165"
  day-primary-foreground: "#fff8ee"
  day-destructive: "#cf2c22"
  day-success: "#12795a"
  day-warning: "#9a6700"
  day-ring: "#c48a00"
  sign-merah: "#d42a20"
  sign-kuning: "#f6b51e"
  sign-tosca: "#19b3a4"
  sign-biru: "#3561d6"
  sign-hijau: "#45ad55"
  sign-oranye: "#ee7418"
  sign-ungu: "#8752d4"
  sign-magenta: "#c02f7c"
  sign-ink-light: "#fff8ee"
  sign-ink-dark: "#2a1a02"
  approval: "#f6b51e"
  approval-hi: "#ffd04e"
  approval-ink: "#2a1a02"
  series-other: "#8c8194"
typography:
  display:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
    fontVariation: "\"opsz\" 72"
  headline:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "1.9rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
    fontVariation: "\"opsz\" 72"
  sign-name:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "2.1rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
    fontVariation: "\"opsz\" 72"
  numeral:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
    fontFeature: "\"tnum\""
    fontVariation: "\"opsz\" 72"
  strip:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.03em"
    fontVariation: "\"opsz\" 72"
  approval-title:
    fontFamily: "Big Shoulders, Arial Narrow, ui-sans-serif, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "0.005em"
    fontVariation: "\"opsz\" 72"
  title:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.25
    fontFeature: "\"tnum\""
  body:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    fontFeature: "\"tnum\""
  body-chat:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.625
    fontFeature: "\"tnum\""
  label:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.33
    fontFeature: "\"tnum\""
  label-rail:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "9px"
  control: "10px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-primary-sm:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  button-outline:
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.sign-ink-light}"
    rounded: "{rounded.control}"
    height: "36px"
  button-send:
    backgroundColor: "{colors.sign-merah}"
    textColor: "{colors.sign-ink-light}"
    rounded: "{rounded.xl}"
    size: "40px"
  input:
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "40px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "24px"
  panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
    padding: "20px"
  nav-rail-item:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label-rail}"
    rounded: "{rounded.xl}"
    padding: "8px 4px 6px"
    width: "88px"
  nav-rail-item-active:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
  status-badge:
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  status-badge-awaiting:
    backgroundColor: "{colors.approval}"
    textColor: "{colors.approval-ink}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  employee-sign-lg:
    typography: "{typography.sign-name}"
    rounded: "{rounded.control}"
    padding: "14px"
    height: "112px"
    width: "184px"
  employee-sign-md:
    rounded: "{rounded.control}"
    padding: "12px"
    height: "96px"
    width: "160px"
  employee-sign-sm:
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "64px"
    width: "136px"
  employee-sign-off:
    backgroundColor: "{colors.sign-off-panel}"
  approval-strip:
    backgroundColor: "{colors.approval}"
    textColor: "{colors.approval-ink}"
    typography: "{typography.strip}"
    padding: "10px 20px"
---

# Design System: Workforce OS

## Overview

**Creative North Star: "Papan Nama Ruko"**

The office is a row of Indonesian shophouses at night, and every AI employee is one backlit acrylic sign on that street. A sign is lit while its employee works, flickers on once when a run starts, flickers on and off while an incident is open, and goes dark when the employee is idle or paused. The owner should be able to read the whole office from across the street: which signs are lit, which one is faulting, and whether the amber "PERLU PERSETUJUAN" strip is showing. Everything else in the interface is the street around those signs. It is a quiet, neutral warm dark that lets the signs carry all the colour.

The material is flat, saturated acrylic, not neon. A lit panel is brighter at its centre and darker at its lower edge, has a 1px inner highlight, and casts a soft coloured light on the ground below it. Headings, sign names and big numbers are condensed sign-painter capitals. Body text and controls are a friendly, plain humanist sans with tabular numerals, at medium-dense app density. The controls are the standard shadcn/Radix set, re-cut to this world's radii and weights. They are never dressed up as signs, except for the one control that sends work out (the chat send button).

Dark (night) is the default theme. Light (day) is the same street by daylight. Grounds turn into cool concrete, unlit signs keep their colour as a pale tint, and lit signs keep their acrylic gradient. The previous restrained direction (warm graphite and paper, one amber accent, an editorial serif, hairlines, minimal motion) was rejected as too basic and stiff. This system is deliberately louder.

**Key Characteristics:**
- Employees are rendered as acrylic lightbox signs, and the sign state (lit, starting, fault, off) is the office's live status.
- The ground is a neutral warm dark. Only the signs, the approval amber and semantic state carry colour.
- Big Shoulders capitals do the shouting (titles, names, numbers). Figtree does the talking (UI, body, data).
- One amber means "needs your decision", everywhere: the approval strip, the rail badge, the awaiting-approval pill and the focus ring.
- State is never carried by light or motion alone. Every sign also writes its status as text, and reduced motion removes the flicker.

## Colors

The palette is a full set of eight acrylic sign colours on a strictly neutral, violet-leaning warm-dark ground, with one reserved amber for approvals.

Unprefixed tokens are the night (default, `.dark`) values. `day-*` tokens are the same roles in the light theme. The sign set and the approval amber are shared by both themes.

### Primary
- **Persetujuan Amber** (`approval`, with `approval-hi` at the lightbox centre and `approval-ink` for its lettering): the colour of "this is waiting for you". It is used for the amber lightbox strip across every pending approval, the count badge on the Approvals rail item, the awaiting-approval status pill, the notification dot and the text selection highlight. At night it is also the focus ring and the input caret (`ring`); by day the ring deepens to **Day Ring Ochre** (`day-ring`) so it stays visible on concrete.

### Secondary
- **The Acrylic Set**: **Merah** (`sign-merah`), **Kuning** (`sign-kuning`), **Tosca** (`sign-tosca`), **Biru** (`sign-biru`), **Hijau** (`sign-hijau`), **Oranye** (`sign-oranye`), **Ungu** (`sign-ungu`), **Magenta** (`sign-magenta`). Each employee owns one. It is dealt from a stable hash of the employee id: the ids are sorted, and a colour already taken passes to the next free one, so up to eight employees never share a colour and every page and client agrees. The set colours the employee's sign, the tint behind their avatar tile, and their series in charts (the `--series-1…8` slots map onto the set, with **Series Other Grey** `series-other` for the remainder). Kuning, Oranye, Tosca and Hijau take dark lettering (`sign-ink-dark`). Merah, Biru, Ungu and Magenta take cream lettering (`sign-ink-light`).
- Two set colours also have fixed system jobs. **Ungu** marks demo and dry-run (the "Demo" chip, the dry-run notice on an approval). **Biru** marks a running task or an executing approval, as a tint behind foreground text.

### Tertiary
- **Incident Red** (`destructive` / `day-destructive`): critical text, incident counts, rejection, the kill switch, guard findings of high severity, and the approval reason line ("irreversible action, needs your approval").
- **Done Tosca-Green** (`success` / `day-success`): completed tasks, approved outcomes, receipt chips ("sent", "pushed"), and the live-connection dot.
- **Warning** (`ring` at night / `day-warning` by day): budget and quota warnings, low/medium guard findings, and routing fallbacks. At night this is the same amber as approvals. The difference is in the treatment: a warning is a 10–15% tint with coloured text, while an approval is a solid amber surface.

### Neutral
- **Ruko Night** (`background`): the street itself, a violet-leaning warm dark. It is also the PWA theme colour.
- **Shopfront** (`card`): cards, panels, the rail and the sheet menu.
- **Awning** (`secondary`, also muted): active nav items, own chat bubbles, row hover and quiet chips.
- **Kerb Line** (`border`): every border and divider.
- Interaction tones sit just above the ramp: **Popover** (`popover`) for floating menus, **Accent** (`accent`) for hover fills, **Input Edge** (`input`) for field strokes and scrollbar thumbs.
- **Lamp Cream** (`foreground`) is body text and **Dusk Mauve** (`muted-foreground`) is secondary text. **Cream Plate** (`primary`, lettered in `primary-foreground`) is the primary button: a cream plate on the dark street, not a colour.
- **Dark Acrylic** (`sign-off-panel`, edged with `sign-off-edge`): an unlit sign at night. The panel gives no light, and the lettering is the sign colour mixed 45% into a pale mauve so the name stays readable.
- Day equivalents: **Cool Concrete** (`day-background`), white cards (`day-card`), **Pale Awning** (`day-secondary`, `day-muted`, `day-accent`), **Day Kerb** (`day-border`, `day-input`), **Day Ink** (`day-foreground`), **Day Mauve** (`day-muted-foreground`). By day the primary button is a Day Ink plate with cream lettering (`day-primary-foreground`).

### Named Rules
**The Signs Carry the Colour Rule.** Grounds, cards, borders and text stay inside the neutral warm-dark ramp (background → card → secondary → border). Saturated colour appears only as an employee's sign colour, the approval amber, or a semantic state. A blue card or a gradient page background breaks the street.

**The One Amber Rule.** A solid Persetujuan Amber surface means a human decision is pending, and nothing else. Do not use it for highlights, promotions or "new" badges.

**The Dealt Colour Rule.** An employee's colour always comes from `signColors()` over the whole workspace (archived employees included), never from a per-page pick. The same person is the same colour on every sign, avatar and chart series.

## Typography

**Display Font:** Big Shoulders, variable with the optical-size axis set to `opsz` 72 (with Arial Narrow, then the system sans, as fallback)
**Body Font:** Figtree (with ui-sans-serif / system-ui)
**Label/Mono Font:** ui-monospace / SFMono-Regular / Menlo, for payload excerpts and code only

**Character:** Big Shoulders is the sign painter. It is condensed, heavy (800) and uppercase, with tight leading, and it is the voice of names, titles and counts. Figtree is the shop assistant: round, open and plain, so UI copy in Bahasa Indonesia and English reads as friendly rather than technical.

### Hierarchy
- **Display** (Big Shoulders 800, 2.6rem, line-height 0.95, uppercase): page titles ("DASBOR"). One per page, in the page header.
- **Headline** (Big Shoulders 800, 1.6–2rem, uppercase): section and panel titles ("KANTOR", a chat thread's name, the context panel's "HARI INI"). The values are 1.9rem on the dashboard, 2rem for the chat thread and 1.6rem for the context panel.
- **Sign Name** (Big Shoulders 800, 2.1 / 1.85 / 1.35rem for lg / md / sm signs, uppercase): the employee's name on their sign.
- **Numeral** (Big Shoulders 800, 2.1rem on phones rising to 2.6rem, tabular): dashboard numbers, the waiting count in the approval strip (2rem), work-in-progress counts (1.5rem), and context panel counts (1.6–1.9rem, coloured amber for approvals and red for incidents).
- **Strip** (Big Shoulders 800, 1.2–1.45rem, letter-spacing 0.02–0.03em, uppercase): the approval strip's "PERLU PERSETUJUAN" and "MENUNGGU PERSETUJUANMU".
- **Approval Title** (Big Shoulders 800, 1.45–1.6rem, line-height 1.08, **mixed case**): the title of a pending approval, which is the only place the display face runs in sentence case, so long invoice and email subjects stay legible.
- **Title** (Figtree 600, 1rem): card titles and employee names in lists.
- **Body** (Figtree 400, 0.875rem, line-height 1.43, tabular numerals everywhere): all UI text. Page descriptions are capped at 70ch.
- **Chat Body** (Figtree 400, 15px, line-height 1.625): message text in threads.
- **Label** (Figtree 600, 0.75rem; rail labels 11px): metadata lines, sign role and status lines, badges, and rail item labels. Labels are sentence case, never tracked-out capitals.

### Named Rules
**The Sign-Painter Capitals Rule.** Big Shoulders is used only for names, titles and numbers, always at weight 800 and uppercase (the pending-approval title is the single mixed-case exception). Figtree is used for every sentence. A paragraph, button label or form label set in the display face is wrong.

**The Tabular Rule.** `tabular-nums` is set on `body`, so credits, counts and times line up in every list and table. Do not switch it off locally.

## Layout

The authenticated app is a three-part frame:

- **Icon rail** (desktop, lg ≥ 1024px): 100px wide (6.25rem), sticky and full height, on Shopfront with a right border. It holds the brand mark (a lit Merah sign with a "W"), then 88px items with an icon over a short label, then the kill switch and live dot pinned to the bottom.
- **Header**: 56px high (h-14), sticky, carrying the workspace name in Big Shoulders 1.25rem. Banners stack under it (quota, kill switch engaged, demo mode, missing credential), and full-height pages size themselves against the measured `--chrome` height.
- **Main**: max-width 1520px, centred, with gutters of 16 / 24 / 32px at base / sm / lg, and vertical padding of 20px rising to 28px.

Rhythm comes from 4px steps. 24px (`2xl`) separates dashboard sections and grid columns. Panels pad 20px (16px on phones). Cards pad 24px. Signs in a facade sit 12px apart. List rows pad 8–10px.

Canonical compositions:
- **Dasbor**: page header, then the **office street** (every employee's sign at lg size, working ones first, scrolling horizontally with snap) as the hero row. Below that, approvals waiting and incidents side by side at 1.35fr / 1fr, then a four-up numbers band (2-up below xl) divided by internal borders rather than gaps, then weekly spend and work in progress (2 / 1 columns), limits, and the employee list.
- **Obrolan (Chat)**: three columns: conversation list (17rem), thread (fluid), and context panel (19rem, from xl up). Each is its own full-height rounded panel. The thread header carries a facade of the conversation's signs (md, or sm on phones), with the team lead tagged "LEAD".

On phones the rail becomes a 288px left sheet with 44px list items, the kill switch moves into the header, facades scroll sideways, and grids collapse to one column. Chat shows either the list or the thread, never both.

## Elevation & Depth

Depth is mostly tonal: the four-step ground ramp plus borders. Real shadows are reserved for things that give off light or float. Plain cards and panels have no shadow at rest. The world's own depth device is the **light cast**: a lit sign throws its colour onto the ground below it, so a lit row reads as glowing, and an unlit sign casts nothing.

### Shadow Vocabulary
- **Sign light** (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.2), inset 0 -16px 26px -14px rgb(0 0 0 / 0.28), 0 22px 30px -18px color-mix(in srgb, var(--sign) 75%, transparent)`): every lit `.sign`. The layers are the edge highlight, the darker lower edge, and the coloured cast below. The panel fill is `radial-gradient(120% 95% at 50% 32%, sign+white 78%, sign 62%, sign+black 84%)`.
- **Unlit sign** (`inset 0 0 0 1px` in Dark Acrylic edge at night, or the sign colour at 32% by day): there is no outer shadow.
- **Approval strip** (`inset 0 -10px 18px -10px rgb(0 0 0 / 0.2)`) over `radial-gradient(140% 120% at 50% 30%, approval-hi, approval 70%)`: the amber lightbox.
- **Pending approval lift** (`0 22px 40px -26px rgb(0 0 0 / 0.7)`): the chat approval card while it is pending.
- **Floating list** (`0 18px 40px -20px rgb(0 0 0 / 0.6)`): the @-mention list over the composer.
- **Avatar tint** (`inset 0 0 0 1px` with the sign colour at 45%, over the sign colour at 26%): employee avatar tiles.

### Named Rules
**The Light Falls Down Rule.** A coloured shadow is only ever the light cast of a lit sign, offset downward (y +22px, spread −18px). It never forms a halo all around, a glow edge or a neon outline, and it never appears under an unlit sign or a plain card.

## Shapes

Corners are gently rounded and consistent by role:

- **Panels and cards**: 16px (`xl`). This covers dashboard sections, chat columns, the shadcn Card, nav items in the rail and sheet, large buttons and the send button.
- **Controls and signs**: 10px (`control`). This covers default buttons, inputs, textareas, select triggers and every employee sign.
- **Small controls and list rows**: 12px (`lg`) for small and xs buttons, receipt chips, conversation rows, pending-approval rows and status rows. Menu items, tab triggers, tags on signs and the demo chip use 9px (`md`). 6px (`sm`) is the smallest step, used for the tightest inner elements.
- **Pills**: fully round, for status badges, count badges, the system note line in chat, and the live dot.
- Own chat bubbles are 16px with a 9px bottom-right corner, a speech tail cut from the rectangle. Employee messages have no bubble, just text beside the tinted avatar tile.

Avatar tiles step with size: 28px at 12px radius, 36px at 10px, and 56px at 16px. Empty states use a dashed border on a 16px panel.

## Components

### Buttons
Buttons are plain and confident, standard shadcn shapes re-cut to this world.
- **Shape:** 10px corners at the default 36px height. Small (32px) and xs (28px) buttons use 12px corners. Large buttons are 44px with 16px corners. Labels are Figtree 600 at 14px.
- **Primary:** Cream Plate with dark lettering at night, Day Ink with cream lettering by day. Hover drops to 90% opacity, and press nudges the button down 1px.
- **Outline:** a 1px Input Edge stroke on a transparent fill, filling with Accent on hover. This is the secondary action everywhere ("Jalankan demo", "Edit & approve", "Reject" in red text).
- **Destructive:** Incident Red with white lettering (60% red at night). It is used for reject-with-feedback and engaging the kill switch.
- **Ghost / icon:** a transparent 36px square that fills with Accent on hover. Header tools use it (notifications, theme, account).
- **Send (signature):** the composer's 40px send button is a lit Merah `.sign` with 16px corners, and it brightens to 110% on hover. It is the only control that wears the sign material.
- **Focus:** a 3px ring in the ring colour at 50% plus a ring-coloured border on every control.

### Chips and Badges
- **Status badge:** a full pill, 2px 8px, label type. Queued uses Awning, Running uses Biru at 22% behind foreground text with a small dot, Awaiting approval is solid Persetujuan Amber with dark ink, Done is a Done Tosca-Green tint, Failed is an Incident Red tint, and Cancelled is muted.
- **Receipt chip:** a 12px-corner chip with a Done-green 30% border and 10% fill, green text and a check icon. Every tool call an employee claims in chat shows its receipt this way.
- **Count badge:** an amber pill with dark ink, 16px high, on the Approvals rail item and in the sheet menu.
- **Demo chip:** an Ungu 9px-corner tag with white lettering.

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** Shopfront (`card`) on Ruko Night, or white on Cool Concrete by day.
- **Shadow Strategy:** none at rest (see Elevation). Only pending approvals lift.
- **Border:** 1px Kerb Line on every card and panel.
- **Internal Padding:** 24px for shadcn Cards and 20px for panels (16px on phones). Numbers bands split into cells with internal borders instead of separate cards.

### Inputs / Fields
- **Style:** 40px high, with 10px corners, a 1px Input Edge stroke, and a transparent fill (Ruko Night at 70% in dark). Text is 16px on phones and 14px from md up. The chat composer textarea is 44px minimum with 16px corners and 15px text.
- **Focus:** the border turns ring colour, with a 3px ring at 50%. The caret is the ring colour.
- **Error / Disabled:** an Incident Red border with a soft red ring when invalid. Disabled fields drop to 50% opacity.

### Navigation
- **Icon rail:** 88px items with an 18px Lucide icon over an 11px semibold label, and 16px corners. Inactive items are Dusk Mauve, turning Awning with Lamp Cream on hover (at 60%) and when active. The current item carries `aria-current="page"`, and the approvals count sits as an amber pill at the item's top right.
- **Kill switch:** pinned to the bottom of the rail as a Red-tinted (12%) tile with red icon and label. Once engaged it turns solid red with white text, and a full-width red banner runs under the header. Only Owners and Admins see it.
- **Phone:** a left sheet of 44px rows (icon, label, count), opened from the header menu button. The brand sign and workspace name sit at the top.

### Employee Sign (signature)
`<EmployeeSign>` is one employee as a backlit acrylic sign: the name in Sign Name capitals at the top, and the role (left) and status (right) in 12px semibold at the bottom. There are three sizes. **lg** (112px high, at least 184px wide) is for the dashboard street. **md** (96 × 160px) is for chat facades from sm up. **sm** (64 × 136px) is for chat on phones. An optional tag (for example "LEAD") sits top right on a 20% black plate.
- **States:** `lit` (working or waiting on you) is the full acrylic gradient with its light cast. `starting` plays one 1.4s flicker-on when the sign goes from off to lit. `fault` (open incident) flickers in a 4s stepped loop until the incident is handled. `off` (idle, paused) is Dark Acrylic at night, or a 14% tint of the sign colour with sign-coloured lettering by day.
- **Accessibility:** each sign is a link (or `role="img"`) labelled "name, role: status". Its status is always written as text, focus is a 2px ring offset from the background, and reduced motion removes both animations and the transition.
- **Facade:** `<OfficeFacade>` is a horizontally scrolling, snap-aligned row of signs, fed live from the office stream. With no ids it shows the whole office, lit signs first. It is used as the dashboard hero and the chat thread header.

### Approval Card (signature)
A pending approval always opens with the **amber lightbox strip**: a shield-alert icon, "PERLU PERSETUJUAN" in Strip capitals, and the age right-aligned. Below the strip come the title in Approval Title type (mixed case), the tool, and the reason in Incident Red. Then the exact payload preview (editable for edit & approve), guard findings, and the decision row: Approve (primary), Edit & approve (outline), Reject (outline, red text). The chat variant (`compact`) folds the details, but high-severity guard findings always stay visible. Once decided, the strip goes away and the status moves into a pill. The dashboard's "waiting" panel reuses the strip as its header whenever anything is pending, with the count in Numeral capitals.

## Do's and Don'ts

### Do:
- **Do** show employees as `<EmployeeSign>` in their dealt acrylic colour whenever their live state matters (facades, office rows). Use the tinted avatar tile in lists.
- **Do** put the amber lightbox strip at the top of every pending approval, wherever it appears (inbox, chat, dashboard).
- **Do** write state out as text next to any light or colour cue. Signs carry "bekerja / santai / insiden", and badges carry their label.
- **Do** set titles, sign names and big numbers in Big Shoulders 800 uppercase at `opsz` 72, and everything else in Figtree with tabular numerals.
- **Do** keep grounds inside the four-step warm-dark ramp (background, card, secondary, border), with 1px Kerb Line borders and 16px panel corners.
- **Do** pair every claim an employee makes in chat with a receipt chip.
- **Do** honour `prefers-reduced-motion`. No flicker and no sign transitions: state is shown by lit/unlit plus text.
- **Do** derive light mode from the same roles (`day-*`). It is the street by day, not a separate palette.

### Don't:
- **Don't** render signs as neon tubes, glow edges or halos. A sign is flat acrylic with an inner gradient and a downward light cast.
- **Don't** use solid Persetujuan Amber for anything except a pending human decision.
- **Don't** colour grounds, cards or page backgrounds with the acrylic set, or put gradients on surfaces other than signs and the approval strip.
- **Don't** pick an employee's colour by hand on one page. Always deal it with `signColors()` across the workspace.
- **Don't** dress ordinary controls (tabs, selects, inputs, outline buttons) in the sign material. The send button is the one exception.
- **Don't** set sentences, button labels or form labels in the display face.
- **Don't** return to the rejected restrained look: graphite and paper, a lone amber accent on an otherwise colourless UI, an editorial serif, hairline-only structure.
