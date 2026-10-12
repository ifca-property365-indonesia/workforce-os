# bloub (vendored)

The engine behind the employee avatars, copied from
[jeremy-prt/bloub](https://github.com/jeremy-prt/bloub) at commit `b4bb3c1`, `src/bot/`
(MIT, see `LICENSE`). Only the framework-free core is here; the Vue component, the
montage (`cycles.ts`), the exporters and the tests stay upstream.

Local changes, kept small so an upstream update stays a copy:

- `skins.ts`: an extra body shape, `papan` (the acrylic shop sign).

The React renderer is `@/components/ui/bot-avatar.tsx`; who gets which shape is
`@/lib/sign.ts`. bloub recreates the x.ai bot avatar and is not affiliated with x.ai.
