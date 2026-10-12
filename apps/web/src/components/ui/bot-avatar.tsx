"use client";

import { useEffect, useId, useMemo, useRef, type CSSProperties } from "react";
import { BotEngine, type BotFrame } from "@/lib/bloub/engine";
import { EXPRESSION_BY_ID } from "@/lib/bloub/expressions";
import { RAYON } from "@/lib/bloub/repere";
import { SHAPE_BY_ID } from "@/lib/bloub/skins";
import type { StateId } from "@/lib/bloub/states";
import { useEmployees, useTemplates } from "@/lib/hooks";
import { botShapeOf, botShapes, employeeLooks, signVars, type BotExpression, type BotShape, type SignColor } from "@/lib/sign";
import { cn } from "@/lib/utils";

/**
 * What the bot is doing. Idle: blinks and lets its gaze drift. Working: turns into the three "typing" dots.
 * Approval: the notification pastille, in approval amber. Fault: eyes wide open. Off (paused): sleepy eyes.
 */
export type BotMood = "idle" | "working" | "approval" | "fault" | "off";

const STATE: Record<BotMood, StateId> = { idle: "idle", working: "thinking", approval: "notify", fault: "wide", off: "idle" };
const SLEEPY = EXPRESSION_BY_ID.get("somnolent") ?? null;

/** half the viewBox, in bloub units (ball radius 100). Tighter than bloub's 158: no orbit states here, so the body fills the tile */
const VB = 124;
/** the instant drawn when nothing animates (server render, reduced motion): every entry morph is over by then */
const STILL = 1.2;
const FPS = 30;

/**
 * One frame as SVG markup. The eyes are holes in the body (bloub's mask), backed by a body-shaped path in the
 * eye colour, so they read the same on any background. bloub's orbit arcs are left out: none of our moods use them.
 */
function markup(f: BotFrame, mask: string): string {
  const eyes = f.eyes.map((e) => `<path d="${e.d}" transform="${e.matrix}" opacity="${e.alpha}" fill="#000"/>`).join("");
  const notch = f.notch ? `<circle cx="${f.notch.x}" cy="${f.notch.y}" r="${f.notch.r}" fill="#000"/>` : "";
  const dots = f.dots
    .map((d) => {
      const fill = d.color ?? "var(--bot-body)";
      const opacity = d.opacity * (d.depth ?? 1);
      return d.d
        ? `<path d="${d.d}" transform="translate(${d.x} ${d.y}) rotate(${d.rot ?? 0}) scale(${RAYON})" fill="${fill}" opacity="${opacity}"/>`
        : `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${fill}" opacity="${opacity}"/>`;
    })
    .join("");
  const notif = f.notif ? `<circle cx="${f.notif.x}" cy="${f.notif.y}" r="${f.notif.r}" fill="var(--approval)"/>` : "";
  return (
    `<defs><mask id="${mask}" maskUnits="userSpaceOnUse" x="${-VB}" y="${-VB}" width="${VB * 2}" height="${VB * 2}">` +
    `<path d="${f.bodyPath}" fill="#fff"/>${eyes}${notch}</mask></defs>` +
    (f.dotsBehind ? dots : "") +
    `<g opacity="${f.bodyAlpha}"><path d="${f.bodyPath}" fill="var(--bot-eye)"/>` +
    `<g mask="url(#${mask})"><rect x="${-VB}" y="${-VB}" width="${VB * 2}" height="${VB * 2}" fill="var(--bot-body)"/></g></g>` +
    (f.dotsBehind ? "" : dots) +
    notif
  );
}

/* ------------------------------------------------ one clock for every avatar on the page */

interface Live {
  engine: BotEngine;
  el: SVGSVGElement;
  mask: string;
  /** per-avatar time offset, so a row of avatars doesn't blink in unison */
  offset: number;
  visible: boolean;
}

const live = new Set<Live>();
let raf = 0;
let last = 0;
let clock = 0;
let since = 0;

function tick(ms: number) {
  raf = live.size ? requestAnimationFrame(tick) : 0;
  // bounded delta: a tab shown again resumes where it was instead of jumping ahead
  clock += last ? Math.min((ms - last) / 1000, 0.064) : 0;
  last = ms;
  if (clock - since < 1 / FPS) return;
  since = clock;
  for (const b of live) if (b.visible) b.el.innerHTML = markup(b.engine.sample(clock + b.offset), b.mask);
}

let observer: IntersectionObserver | null = null;
const byEl = new WeakMap<Element, Live>();
function watch(b: Live) {
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const it = byEl.get(e.target);
      if (it) it.visible = e.isIntersecting;
    }
  });
  byEl.set(b.el, b);
  observer.observe(b.el);
  live.add(b);
  if (!raf) {
    last = 0;
    raf = requestAnimationFrame(tick);
  }
}
function unwatch(b: Live) {
  observer?.unobserve(b.el);
  live.delete(b);
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------ the avatar */

const offsetOf = (seed: string) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return (Math.abs(h) % 997) / 10;
};

/**
 * An employee as a little bloub bot: their own body shape, in their sign colour. Purely decorative (the name
 * always sits next to it), so it is hidden from assistive tech.
 */
export function BotAvatar({ shape, color, expression, mood = "idle", seed, className }: { shape: BotShape; color?: SignColor; expression?: BotExpression; mood?: BotMood; seed: string; className?: string }) {
  const face = (mood === "off" ? SLEEPY : expression ? EXPRESSION_BY_ID.get(expression) : null) ?? null;
  const mask = `bot${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const radii = SHAPE_BY_ID.get(shape)?.radii ?? null;
  const offset = useMemo(() => offsetOf(seed), [seed]);
  const ref = useRef<SVGSVGElement>(null);
  const live = useRef<Live | null>(null);
  // the engine is a pure function of time: the server and the first client render draw the same still frame
  const engine = useMemo(() => new BotEngine(RAYON, STATE[mood], radii, face), []); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useMemo(() => markup(engine.sample(STILL), mask), [engine, mask]);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const b: Live = { engine, el, mask, offset, visible: true };
    live.current = b;
    watch(b);
    return () => {
      unwatch(b);
      live.current = null;
    };
  }, [engine, mask, offset]);

  // shape and mood changes morph (bloub eases between any two shapes and states)
  useEffect(() => {
    const now = clock + offset;
    engine.setShape(radii, now);
    engine.setState(STATE[mood], now);
    engine.setExpression(face, now);
    if (!live.current && ref.current) ref.current.innerHTML = markup(engine.sample(now + STILL), mask);
  }, [engine, radii, mood, face, offset, mask]);

  // a wink when the pointer comes by, only when the bot is just sitting there
  const wink = () => {
    if (mood !== "idle" || !live.current) return;
    engine.setState("wink", clock + offset);
    setTimeout(() => engine.setState(STATE[mood], clock + offset), 1100);
  };

  const style = (color ? { ...signVars(color), "--bot-body": "var(--sign)", "--bot-eye": "var(--sign-ink)" } : { "--bot-body": "var(--foreground)", "--bot-eye": "var(--background)" }) as CSSProperties;
  return (
    <svg
      ref={ref}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      className={cn("block size-full overflow-visible", className)}
      style={style}
      aria-hidden
      onPointerEnter={wink}
      dangerouslySetInnerHTML={{ __html: first }}
    />
  );
}

/**
 * Shape and colour of an employee, dealt over the whole workspace (archived ones too, so neither ever shifts).
 * A role template (`seed` is its key) gets a shape dealt over the template catalogue, and no colour.
 */
export function useBotLook(id: string | null | undefined, seed?: string): { shape: BotShape; color?: SignColor; expression?: BotExpression } {
  const { data } = useEmployees();
  const { data: tpl } = useTemplates(!!seed && !id);
  const deck = useMemo(() => employeeLooks(data ?? []), [data]);
  const templates = useMemo(() => botShapes((tpl?.templates ?? []).map((t) => t.key)), [tpl]);
  return {
    shape: (id ? deck.shapes.get(id) : seed ? templates.get(seed) : undefined) ?? botShapeOf(id || seed || ""),
    color: id ? deck.colors.get(id) : undefined,
    expression: id ? deck.expressions.get(id) : undefined,
  };
}
