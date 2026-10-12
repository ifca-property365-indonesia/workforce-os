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

/** Deals one of `deck` to every id: from a hash of the id (plus `salt`), passing on to the next free one while any is left. */
function deal<T>(ids: readonly string[], deck: readonly T[], salt = ""): Map<string, T> {
  const out = new Map<string, T>();
  const taken = new Set<T>();
  for (const id of [...new Set(ids)].sort()) {
    let i = stableHash(id + salt) % deck.length;
    if (taken.size < deck.length) while (taken.has(deck[i]!)) i = (i + 1) % deck.length;
    const c = deck[i]!;
    taken.add(c);
    out.set(id, c);
  }
  return out;
}

export function signColors(ids: readonly string[]): Map<string, SignColor> {
  return deal(ids, SIGN_COLORS);
}

/**
 * Every employee's bot avatar has its own body shape (bloub's customiser shapes). No plain circle: that one is
 * the x.ai bot's. Dealt like the colours, but from another hash, so shape and colour don't travel in pairs.
 */
export const BOT_SHAPES = ["papan", "squircle", "galet", "capsule", "hexagone", "nuage", "goutte", "triangle"] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

export function botShapes(ids: readonly string[]): Map<string, BotShape> {
  return deal(ids, BOT_SHAPES, ":shape");
}

/** A shape for something that is not (yet) an employee, such as a role template. */
export function botShapeOf(seed: string): BotShape {
  return BOT_SHAPES[stableHash(seed + ":shape") % BOT_SHAPES.length]!;
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
