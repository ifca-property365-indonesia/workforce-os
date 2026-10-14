import type { CSSProperties } from "react";
import { stableHash, type Activity } from "@wfos/shared/office";

/**
 * Every employee has an acrylic sign colour (globals.css --sign-*). Colours are dealt from the employee id,
 * and a colour already taken by another employee passes to the next free one, so up to eight employees never
 * share a colour. The same set of ids gives the same colours on every page and every client.
 */
export const SIGN_COLORS = ["merah", "biru", "tosca", "kuning", "magenta", "hijau", "ungu", "oranye"] as const;
export type SignColor = (typeof SIGN_COLORS)[number];

/** colours light enough to need dark lettering */
const DARK_INK: ReadonlySet<SignColor> = new Set(["kuning", "oranye", "tosca", "hijau"]);

/**
 * Deals one of `deck` to every id: from a hash of the id (plus `salt`), passing on to the next free one while any
 * is left. A `fixed` choice (the owner picked it) is kept as is and taken off the deck first.
 */
function deal<T>(ids: readonly string[], deck: readonly T[], salt = "", fixed?: ReadonlyMap<string, T>): Map<string, T> {
  const out = new Map<string, T>();
  const taken = new Set<T>();
  const all = [...new Set(ids)].sort();
  for (const id of all) {
    const c = fixed?.get(id);
    if (c === undefined) continue;
    taken.add(c);
    out.set(id, c);
  }
  for (const id of all) {
    if (out.has(id)) continue;
    let i = stableHash(id + salt) % deck.length;
    if (deck.some((d) => !taken.has(d))) while (taken.has(deck[i]!)) i = (i + 1) % deck.length;
    const c = deck[i]!;
    taken.add(c);
    out.set(id, c);
  }
  return out;
}

export function signColors(ids: readonly string[], fixed?: ReadonlyMap<string, SignColor>): Map<string, SignColor> {
  return deal(ids, SIGN_COLORS, "", fixed);
}

/**
 * Every employee's bot avatar has its own body shape (bloub's customiser shapes). The automatic deal leaves out
 * the plain circle (the x.ai bot's); an owner may still pick it. Dealt like the colours, but from another hash,
 * so shape and colour don't travel in pairs.
 */
export const BOT_SHAPES = ["papan", "squircle", "galet", "capsule", "hexagone", "nuage", "goutte", "triangle", "cercle"] as const;
export type BotShape = (typeof BOT_SHAPES)[number];
const DEALT_SHAPES = BOT_SHAPES.filter((s) => s !== "cercle");

export function botShapes(ids: readonly string[], fixed?: ReadonlyMap<string, BotShape>): Map<string, BotShape> {
  return deal(ids, DEALT_SHAPES, ":shape", fixed);
}

/** A shape for something that is not (yet) an employee, such as a role template. */
export function botShapeOf(seed: string): BotShape {
  return DEALT_SHAPES[stableHash(seed + ":shape") % DEALT_SHAPES.length]!;
}

/** bloub's rest expressions (the eyes while the bot sits idle) */
export const BOT_EXPRESSIONS = ["neutre", "attentif", "surpris", "excite", "heureux", "hilare", "colere", "triste", "effraye", "mefiant", "confus", "curieux", "fier", "timide", "blase", "somnolent"] as const;
export type BotExpression = (typeof BOT_EXPRESSIONS)[number];

/** What an owner picked for an employee's bot; a missing part is dealt automatically. */
export interface BotChoice {
  shape?: BotShape;
  color?: SignColor;
  expression?: BotExpression;
}

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (list as readonly string[]).includes(v ?? "") ? (v as T) : undefined;

/** Reads the employee's `avatar` field: "bot:<shape>/<colour>/<expression>", "-" for automatic. Anything else (an old emoji) is all automatic. */
export function parseBotChoice(avatar: string | null | undefined): BotChoice {
  if (!avatar?.startsWith("bot:")) return {};
  const [shape, color, expression] = avatar.slice(4).split("/");
  return { shape: pick(BOT_SHAPES, shape), color: pick(SIGN_COLORS, color), expression: pick(BOT_EXPRESSIONS, expression) };
}

/** The `avatar` value for a choice; nothing picked gives "" (all automatic). */
export function formatBotChoice(c: BotChoice): string {
  return c.shape || c.color || c.expression ? `bot:${c.shape ?? "-"}/${c.color ?? "-"}/${c.expression ?? "-"}` : "";
}

/** Shape, colour and rest expression of every employee: their own choices first, the rest dealt around them. */
export function employeeLooks(emps: readonly { id: string; avatar?: string | null }[]): {
  shapes: Map<string, BotShape>;
  colors: Map<string, SignColor>;
  expressions: Map<string, BotExpression>;
} {
  const ids = emps.map((e) => e.id);
  const choices = emps.map((e) => [e.id, parseBotChoice(e.avatar)] as const);
  const only = <K extends keyof BotChoice>(k: K): Map<string, NonNullable<BotChoice[K]>> => {
    const out = new Map<string, NonNullable<BotChoice[K]>>();
    for (const [id, c] of choices) if (c[k]) out.set(id, c[k]!);
    return out;
  };
  return { shapes: botShapes(ids, only("shape")), colors: signColors(ids, only("color")), expressions: only("expression") };
}

/** the CSS variables a `.sign` (or a tinted avatar) reads */
export function signVars(color: SignColor): CSSProperties {
  return { "--sign": `var(--sign-${color})`, "--sign-ink": DARK_INK.has(color) ? "#2a1a02" : "#fff8ee" } as CSSProperties;
}

export type SignState = "lit" | "starting" | "fault" | "off";

/** Working (or waiting on you) lights the sign; an open incident makes it flicker; idle and paused are dark. */
export function signStateOf(activity: Activity, incident: boolean): Exclude<SignState, "starting"> {
  if (incident) return "fault";
  return activity === "idle" || activity === "paused" ? "off" : "lit";
}

/**
 * A division's sign: its own colour ("#rrggbb" from the Divisions page) or, without one, a set colour dealt from its
 * id. Lettering is dark on light panels and cream on dark ones, as for the set.
 */
export function divisionSignVars(color: string, id: string): CSSProperties {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return signVars(SIGN_COLORS[stableHash(`division:${id}`) % SIGN_COLORS.length]!);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return { "--sign": color, "--sign-ink": luminance > 0.28 ? "#2a1a02" : "#fff8ee" } as CSSProperties;
}

/** The set as hex values, for the division colour picker (globals.css --sign-*). */
export const SIGN_HEX: Record<SignColor, string> = {
  merah: "#d42a20",
  kuning: "#f6b51e",
  tosca: "#19b3a4",
  biru: "#3561d6",
  hijau: "#45ad55",
  oranye: "#ee7418",
  ungu: "#8752d4",
  magenta: "#c02f7c",
};
