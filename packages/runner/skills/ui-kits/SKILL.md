---
name: ui-kits
description: The workspace's UI templates (design kits) for the apps the platform builds - tokens, fonts, component styles and rules per kit. Read when a task names a UI template, asks to restyle an app, or starts a new app's interface.
---

# UI kits

Each kit in `kits/<id>/` is a complete visual direction for a business app:

- `DESIGN.md`: the character, the signature moves, layout, tables, forms, statuses, and what to avoid. Read it first.
- `tokens.css`: CSS variables (`--ui-*`): colors, radius, shadows, fonts. The single source of truth for the look.
- `kit.css`: the personality on top of `base.css` (the shared structure and class contract).
- `meta.json`: name, mode (light / dark), fonts with their npm packages.
- `../../preview.html` shows the same five screens (dashboard, list, form, detail, login) for every kit.

| id | Name | Mode | For |
|---|---|---|---|
| korporat | Korporat | light | enterprise portals, ERP, customer portals that should feel premium |
| swiss | Swiss Grid | light | data-heavy apps that must feel precise and calm |
| material | Material Lembut | light | everyday operations apps, field staff, Android-familiar |
| brutal | Neo Brutal | light | internal apps that want to be loud and memorable |
| malam | Dasbor Malam | dark | monitoring dashboards, 24/7 operations |
| editorial | Editorial | light | reporting, legal, management portals |
| clay | Clay Ceria | light | friendly resident / customer / booking apps |
| industri | Industri | dark | engineering, warehouse, maintenance, developer tools |

The task says which kit the app uses (or gives a custom design system as data). Use exactly that one.

## Applying a kit to a Next.js app (app-nextjs)

1. Copy the kit's `tokens.css` variables into `app/globals.css` (`:root { … }`). With Tailwind, map them in the theme
   (`--color-primary: var(--ui-primary)` …) instead of hard-coding hex values in components.
2. Fonts ship with the app: install the npm packages listed in `meta.json` (`@fontsource-variable/…`), import them once in
   `app/layout.tsx`. Never Google Fonts or a CDN (the sandbox cannot reach them and the build breaks). New dependencies
   go to approval.
3. Build the app's own components (Button, Card, Table, Badge, Field, Dialog, Tabs, Sidebar…) from the tokens and the
   rules in `DESIGN.md` and `kit.css`. Reuse the class contract of `base.css` when plain CSS is simpler. Do not paste
   `preview.html` into the app: it is a reference, not app code.
4. Keep it accessible: text contrast at least 4.5:1 (the kit's pairs pass; keep them paired), visible focus, labels on
   every field, status never by color alone (a word in the badge), targets at least 40px, `prefers-reduced-motion`.
5. Responsive: the sidebar becomes a top bar under 860px; tables scroll horizontally or become card lists on phones.
6. A dark kit is dark by default; add a light variant only when the task asks for one (and the reverse).

## Restyling an existing app

A restyle changes how the app looks, never what it does: no changes to data, routes, API, validation, permissions or
copy, unless the task says so. Work screen by screen, keep the existing component structure, replace hard-coded colors
and fonts with the tokens, and list in your summary any screen you could not convert.

## Figma

When the task gives a Figma file, read it with the Figma tools (frames, variables, components) and take its colors,
type and spacing as the tokens; the kit's rules fill what Figma does not say. Figma is read-only for you: never create,
edit or comment in a Figma file. Note in your summary what Figma did not cover.
