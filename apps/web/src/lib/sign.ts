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

export function signColors(ids: readonly string[]): Map<string, SignColor> {
  const out = new Map<string, SignColor>();
  const taken = new Set<SignColor>();
  for (const id of [...new Set(ids)].sort()) {
    let i = stableHash(id) % SIGN_COLORS.length;
    if (taken.size < SIGN_COLORS.length) while (taken.has(SIGN_COLORS[i]!)) i = (i + 1) % SIGN_COLORS.length;
    const c = SIGN_COLORS[i]!;
    taken.add(c);
    out.set(id, c);
  }
  return out;
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
