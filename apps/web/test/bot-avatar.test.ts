import { describe, expect, it } from "vitest";
import { stableHash } from "@wfos/shared/office";
import { BotEngine } from "@/lib/bloub/engine";
import { EXPRESSION_BY_ID } from "@/lib/bloub/expressions";
import { RAYON } from "@/lib/bloub/repere";
import { SHAPE_BY_ID } from "@/lib/bloub/skins";
import { BOT_SHAPES, SIGN_COLORS, botShapeOf, botShapes, signColors } from "@/lib/sign";

const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);

describe("bot avatar shapes", () => {
  it("gives up to eight employees eight different shapes, none of them the x.ai circle", () => {
    const shapes = botShapes(ids);
    expect(new Set(shapes.values()).size).toBe(8);
    for (const s of BOT_SHAPES) expect(SHAPE_BY_ID.has(s)).toBe(true);
    expect(BOT_SHAPES).not.toContain("cercle");
  });

  it("is stable: the same ids in any order deal the same shapes, and a template seed always gets the same one", () => {
    expect(botShapes([...ids].reverse())).toEqual(botShapes(ids));
    expect(botShapeOf("developer")).toBe(botShapeOf("developer"));
  });

  it("left the sign colours exactly as they were dealt before", () => {
    // the dealing loop signColors had before it moved onto the shared helper
    const before = new Map<string, string>();
    const taken = new Set<string>();
    for (const id of [...ids.slice(0, 5)].sort()) {
      let i = stableHash(id) % SIGN_COLORS.length;
      while (taken.has(SIGN_COLORS[i]!)) i = (i + 1) % SIGN_COLORS.length;
      taken.add(SIGN_COLORS[i]!);
      before.set(id, SIGN_COLORS[i]!);
    }
    expect(signColors(ids.slice(0, 5))).toEqual(before);
  });

  it("renders every shape in every mood without a NaN in the path data", () => {
    const sleepy = EXPRESSION_BY_ID.get("somnolent") ?? null;
    for (const shape of BOT_SHAPES) {
      for (const [state, expr] of [["idle", null], ["thinking", null], ["notify", null], ["wide", null], ["wink", null], ["idle", sleepy]] as const) {
        const e = new BotEngine(RAYON, "idle", SHAPE_BY_ID.get(shape)!.radii, null);
        e.setState(state, 0.5);
        e.setExpression(expr, 0.5);
        for (const t of [0, 0.7, 1.2, 3.9]) {
          const f = e.sample(t);
          const text = JSON.stringify(f);
          expect(text, `${shape} ${state} @${t}`).not.toMatch(/NaN|Infinity/);
          expect(f.bodyPath.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
