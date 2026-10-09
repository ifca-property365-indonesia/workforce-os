"use client";

import { useEffect, useRef, useState } from "react";
import { animationFor, moveToward, resolveLook, SHIRT_COLORS, spotPoint, stableHash, type Point } from "@wfos/shared/office";
import type { OfficePerson, OfficeState } from "./use-office";

export interface OfficeViewProps {
  state: OfficeState;
  reducedMotion: boolean;
  labels: { lounge: string; reception: string; activity: (p: OfficePerson) => string };
  onSelect: (p: OfficePerson) => void;
}

const MARGIN = 1; // tiles around the office
export const BODY_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b"];

function palette(dark: boolean) {
  return dark
    ? { bg: "#0f1117", floor: "#1b1f2a", wall: "#394050", muted: "#9aa3b5", desk: "#5b4636", monitor: "#1e293b", screenOn: "#7dd3fc", shelf: "#6b4f3a", rack: "#111827", sofa: "#3b4a6b", name: "#e5e7eb", bubble: "#f8fafc", chair: "#2d3444" }
    : { bg: "#eef1f6", floor: "#ffffff", wall: "#c9d0dc", muted: "#64748b", desk: "#c8a27a", monitor: "#334155", screenOn: "#38bdf8", shelf: "#9a6b4b", rack: "#1f2937", sofa: "#a5b4fc", name: "#1f2937", bubble: "#ffffff", chair: "#d6dbe4" };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The 2D office: canvas, 60 fps while visible, paused when the tab is hidden, no walking with reduced motion. */
export function Office2D({ state, reducedMotion, labels, onSelect }: OfficeViewProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const positions = useRef(new Map<string, Point & { walking: boolean }>());
  const [scale, setScale] = useState(24);
  const [dpr, setDpr] = useState(1);
  const hover = useRef<string | null>(null);
  const draw = useRef<(dt: number, t: number) => void>(() => {});
  const { layout } = state;
  const wTiles = layout.width + 2 * MARGIN;
  const hTiles = layout.height + 2 * MARGIN;

  // fit the width; below 16 px per tile the office scrolls sideways (phones)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setDpr(window.devicePixelRatio || 1);
    const fit = () => setScale(Math.max(16, Math.min(40, el.clientWidth / wTiles)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wTiles]);

  useEffect(() => {
    draw.current = (dt: number, t: number) => {
      const c = canvas.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      const s = scale;
      const pal = palette(document.documentElement.classList.contains("dark"));
      const now = Date.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, wTiles * s, hTiles * s);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * s * MARGIN, dpr * s * MARGIN);
      ctx.textBaseline = "middle";

      const people = state.people.current;
      const anims = new Map([...people.values()].map((p) => [p.id, animationFor(state.activityOf(p, now), p.id, now)]));

      // rooms
      for (const r of [...layout.rooms, layout.lounge]) {
        ctx.fillStyle = pal.floor;
        ctx.strokeStyle = pal.wall;
        ctx.lineWidth = 0.12;
        roundRect(ctx, r.x, r.y, r.w, r.h, 0.3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = pal.muted;
        ctx.font = "600 0.42px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(r.kind === "lounge" ? labels.lounge : state.roomLabel(r.key), r.x + 0.35, r.y + 0.55, r.w - 0.7);
        if (r.kind === "lounge") continue;
        // bookshelf
        ctx.fillStyle = pal.shelf;
        ctx.fillRect(r.bookshelf.x - 1, r.bookshelf.y - 0.4, 2, 0.8);
        for (let i = 0; i < 7; i++) {
          ctx.fillStyle = BODY_COLORS[(i * 3 + r.x) % BODY_COLORS.length]!;
          ctx.fillRect(r.bookshelf.x - 0.9 + i * 0.27, r.bookshelf.y - 0.3, 0.18, 0.6);
        }
        // server rack with LEDs (steady with reduced motion)
        ctx.fillStyle = pal.rack;
        ctx.fillRect(r.rack.x - 0.45, r.rack.y - 0.45, 0.9, 0.9);
        for (let i = 0; i < 3; i++) {
          const on = reducedMotion || Math.floor(t / 400 + i * 1.7 + r.x) % 3 !== 0;
          ctx.fillStyle = on ? "#22c55e" : "#14532d";
          ctx.fillRect(r.rack.x - 0.3, r.rack.y - 0.3 + i * 0.25, 0.12, 0.1);
        }
      }
      // lounge furniture
      ctx.fillStyle = pal.sofa;
      for (const seat of layout.lounge.seats) {
        roundRect(ctx, seat.x - 0.7, seat.y - 0.15, 1.4, 0.6, 0.2);
        ctx.fill();
      }
      ctx.fillStyle = pal.rack;
      ctx.fillRect(layout.lounge.coffee.x - 0.4, layout.lounge.coffee.y - 0.4, 0.8, 0.8);
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(layout.lounge.coffee.x, layout.lounge.coffee.y + 0.1, 0.15, 0, Math.PI * 2);
      ctx.fill();

      // reception: the company name on the back wall, the counter in the middle
      const rc = layout.reception;
      ctx.fillStyle = pal.floor;
      ctx.strokeStyle = pal.wall;
      ctx.lineWidth = 0.12;
      roundRect(ctx, rc.x, rc.y, rc.w, rc.h, 0.3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pal.name;
      ctx.font = "800 0.6px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(state.workspaceName || labels.reception, rc.x + rc.w / 2, rc.y + 0.7, rc.w - 1);
      ctx.textAlign = "left";
      ctx.fillStyle = pal.desk;
      roundRect(ctx, rc.desk.x - 1.6, rc.desk.y - 0.3, 3.2, 0.6, 0.15);
      ctx.fill();

      // desks and chairs
      for (const d of layout.desks) {
        ctx.fillStyle = pal.chair;
        ctx.beginPath();
        ctx.arc(d.seat.x, d.seat.y, 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.desk;
        roundRect(ctx, d.x, d.y, 2, 0.9, 0.12);
        ctx.fill();
        const a = anims.get(d.employeeId);
        const working = a?.spot === "desk" && (a.pose === "type" || a.pose === "sit") && positions.current.get(d.employeeId)?.walking === false;
        ctx.fillStyle = pal.monitor;
        ctx.fillRect(d.x + 0.55, d.y + 0.08, 0.9, 0.5);
        ctx.fillStyle = working ? pal.screenOn : pal.monitor;
        ctx.fillRect(d.x + 0.62, d.y + 0.14, 0.76, 0.36);
      }

      // characters, back to front
      const drawn: { p: OfficePerson; pos: Point & { walking: boolean }; anim: ReturnType<typeof animationFor> }[] = [];
      for (const p of people.values()) {
        const anim = anims.get(p.id)!;
        const target = spotPoint(layout, p.id, anim.spot);
        const cur = positions.current.get(p.id) ?? { ...target, walking: false };
        const m = reducedMotion ? { pos: target, arrived: true } : moveToward(cur, target, dt);
        const next = { ...m.pos, walking: !m.arrived };
        positions.current.set(p.id, next);
        drawn.push({ p, pos: next, anim });
      }
      for (const id of positions.current.keys()) if (!people.has(id)) positions.current.delete(id);
      drawn.sort((a, b) => a.pos.y - b.pos.y);
      for (const { p, pos, anim } of drawn) {
        const phase = (stableHash(p.id) % 1000) / 160;
        const bob = reducedMotion ? 0 : pos.walking ? Math.abs(Math.sin(t / 110 + phase)) * 0.12 : anim.pose === "type" ? Math.sin(t / 70 + phase) * 0.03 : anim.pose === "chat" ? Math.sin(t / 300 + phase) * 0.05 : 0;
        const sitting = !pos.walking && (anim.pose === "sit" || anim.pose === "type" || anim.pose === "sleep");
        const x = pos.x;
        const y = pos.y - (sitting ? 0.15 : 0.35) - bob;
        ctx.fillStyle = "rgba(0,0,0,0.15)";
        ctx.beginPath();
        ctx.ellipse(pos.x, pos.y + 0.05, 0.32, 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = SHIRT_COLORS[resolveLook(p.id, p.look).shirt]!;
        roundRect(ctx, x - 0.3, y - 0.3, 0.6, sitting ? 0.5 : 0.65, 0.2);
        ctx.fill();
        ctx.fillStyle = "#fde2c4";
        ctx.beginPath();
        ctx.arc(x, y - 0.52, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "0.38px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(p.avatar || "🤖", x, y - 0.5);
        if (hover.current === p.id) {
          ctx.strokeStyle = "#6366f1";
          ctx.lineWidth = 0.08;
          ctx.beginPath();
          ctx.arc(x, y - 0.3, 0.75, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (anim.bubble) {
          const by = y - 1.25 - (reducedMotion ? 0 : Math.sin(t / 250 + phase) * 0.05);
          ctx.fillStyle = anim.bubble === "!" ? "#f59e0b" : pal.bubble;
          roundRect(ctx, x - 0.32, by - 0.27, 0.64, 0.5, 0.18);
          ctx.fill();
          ctx.strokeStyle = pal.wall;
          ctx.lineWidth = 0.04;
          ctx.stroke();
          ctx.fillStyle = anim.bubble === "!" ? "#fff" : pal.muted;
          ctx.font = "700 0.36px system-ui, sans-serif";
          ctx.fillText(anim.bubble, x, by);
        }
        // names at desks; people standing together at a shelf, rack or the coffee machine show theirs on hover
        if ((s >= 22 && (pos.walking || anim.spot === "desk" || anim.spot === "lounge")) || hover.current === p.id) {
          ctx.fillStyle = pal.name;
          ctx.font = `${hover.current === p.id ? 600 : 500} 0.3px system-ui, sans-serif`;
          ctx.fillText(p.name, x, pos.y + 0.38, 2.6);
        }
      }
    };
  });

  // render loop: rAF while visible; with reduced motion, draw on change and every few seconds
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const frame = (t: number) => {
      draw.current(Math.min(100, t - last), t);
      last = t;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
    const start = () => {
      stop();
      if (document.hidden) return;
      if (reducedMotion) {
        draw.current(0, performance.now());
        timer = setInterval(() => draw.current(0, performance.now()), 5000);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [reducedMotion]);

  // with reduced motion there is no loop to pick up changes
  useEffect(() => {
    if (reducedMotion && !document.hidden) draw.current(0, performance.now());
  }, [reducedMotion, state.version, scale, dpr, layout]);

  const hit = (e: React.PointerEvent | React.MouseEvent): OfficePerson | null => {
    const r = canvas.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale - MARGIN;
    const y = (e.clientY - r.top) / scale - MARGIN;
    let best: OfficePerson | null = null;
    let bestD = 0.8;
    for (const p of state.people.current.values()) {
      const pos = positions.current.get(p.id);
      if (!pos) continue;
      const d = Math.hypot(pos.x - x, pos.y - 0.6 - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  return (
    <div ref={wrap} className="w-full overflow-x-auto rounded-lg border">
      <canvas
        ref={canvas}
        aria-hidden="true"
        width={Math.round(wTiles * scale * dpr)}
        height={Math.round(hTiles * scale * dpr)}
        style={{ width: wTiles * scale, height: hTiles * scale, display: "block" }}
        className="touch-manipulation"
        onPointerMove={(e) => {
          const p = hit(e);
          hover.current = p?.id ?? null;
          e.currentTarget.style.cursor = p ? "pointer" : "default";
          e.currentTarget.title = p ? `${p.name}: ${labels.activity(p)}` : "";
          if (reducedMotion) draw.current(0, performance.now());
        }}
        onClick={(e) => {
          const p = hit(e);
          if (p) onSelect(p);
        }}
      />
    </div>
  );
}
