"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DesktopContext, type DesktopNav } from "@/lib/nav";
import { clampWin, current, type Insets, type Win } from "./geometry";
import { isLocalHref, pathOf, routeOf } from "./routes";

export { current, type Win };

/**
 * The desktop's window manager. A window is a stack of in-app paths (its own back history) plus a rectangle.
 * One window per app: opening an app that already has a window brings it forward and navigates it, unless a new
 * window is asked for. The layout is kept per device in localStorage; the address bar follows the focused window.
 */

interface WindowManager {
  wins: Win[];
  focusedId: string | null;
  insets: Insets;
  open: (href: string, opts?: { newWindow?: boolean }) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  toggleMax: (id: string) => void;
  move: (id: string, r: Partial<Pick<Win, "x" | "y" | "w" | "h">>) => void;
  navigate: (id: string, href: string, mode: "push" | "replace") => void;
  back: (id: string) => void;
  showDesktop: () => void;
}

const KEY = "wfos-desktop-v1";
/** the layout is kept per person: another account in the same browser starts from its own */
const keyFor = (userId: string) => `${KEY}:${userId}`;
const MAX_WINDOWS = 10;
/** a page outside the desktop (sign-in, password change…): a normal navigation, same-origin paths only */
function leave(href: string) {
  if (isLocalHref(href)) window.location.assign(href);
}

/** paths that are the desktop itself rather than a window */
const DESKTOP_PATHS = new Set(["/office", "/"]);


const Ctx = createContext<WindowManager | null>(null);

export function useWindows(): WindowManager {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWindows outside WindowProvider");
  return v;
}

interface Saved {
  id: unknown;
  path: unknown;
  x: unknown;
  y: unknown;
  w: unknown;
  h: unknown;
  z: unknown;
  min: unknown;
  max: unknown;
}

function load(userId: string): Win[] {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(userId)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as Saved[])
      .filter((w) => !!w && typeof w.path === "string" && !!routeOf(w.path))
      .slice(0, MAX_WINDOWS)
      .map((w) => ({ id: String(w.id), history: [w.path as string], at: 0, x: Number(w.x) || 0, y: Number(w.y) || 0, w: Number(w.w) || 900, h: Number(w.h) || 640, z: Number(w.z) || 1, min: !!w.min, max: !!w.max }));
  } catch {
    return [];
  }
}

const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const topZ = (ws: Win[]) => ws.reduce((m, w) => Math.max(m, w.z), 0) + 1;
const topVisible = (ws: Win[]) => ws.filter((w) => !w.min).sort((a, b) => b.z - a.z)[0]?.id ?? null;

export function WindowProvider({ children, initialPath, insets, userId }: { children: ReactNode; initialPath: string; insets: Insets; userId: string }) {
  const [wins, setWins] = useState<Win[]>(() => load(userId));
  const [focusedId, setFocused] = useState<string | null>(() => topVisible(load(userId)));
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  // the latest windows, for callbacks that decide before they update (setState updaters must stay pure)
  const winsRef = useRef(wins);
  winsRef.current = wins;

  const focus = useCallback((id: string) => {
    setWins((ws) => {
      const z = topZ(ws);
      return ws.map((w) => (w.id === id ? { ...w, z, min: false } : w));
    });
    setFocused(id);
  }, []);

  const showDesktop = useCallback(() => {
    setWins((ws) => ws.map((w) => ({ ...w, min: true })));
    setFocused(null);
  }, []);

  const open = useCallback(
    (href: string, opts?: { newWindow?: boolean }) => {
      const path = pathOf(href);
      if (path && DESKTOP_PATHS.has(path)) return showDesktop();
      const route = routeOf(href);
      if (!route) return leave(href);
      const ws = winsRef.current;
      const same = opts?.newWindow ? undefined : ws.find((w) => routeOf(current(w))?.app.key === route.app.key);
      if (same) {
        setWins((list) =>
          list.map((w) => {
            if (w.id !== same.id) return w;
            const history = current(w) === href ? w.history : [...w.history.slice(0, w.at + 1), href];
            return { ...w, history, at: history.length - 1, z: topZ(list), min: false };
          }),
        );
        setFocused(same.id);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const ins = insetsRef.current;
      const [dw, dh] = route.app.size;
      const n = ws.filter((w) => !w.min).length % 6;
      const width = Math.min(dw, vw - 48);
      const height = Math.min(dh, vh - ins.top - ins.bottom - 24);
      const id = newId();
      setWins((list) => {
        const win = clampWin({ id, history: [href], at: 0, w: width, h: height, x: Math.round((vw - width) / 2 + n * 28 - 56), y: ins.top + 16 + n * 26, z: topZ(list), min: false, max: false }, vw, vh, ins);
        // at most MAX_WINDOWS: the one used longest ago closes
        const kept = list.length >= MAX_WINDOWS ? [...list].sort((a, b) => b.z - a.z).slice(0, MAX_WINDOWS - 1) : list;
        return [...kept, win];
      });
      setFocused(id);
    },
    [showDesktop],
  );

  const close = useCallback((id: string) => {
    const rest = winsRef.current.filter((w) => w.id !== id);
    setWins((ws) => ws.filter((w) => w.id !== id));
    setFocused(topVisible(rest));
  }, []);

  const minimize = useCallback((id: string) => {
    const out = winsRef.current.map((w) => (w.id === id ? { ...w, min: true } : w));
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, min: true } : w)));
    setFocused(topVisible(out));
  }, []);

  const toggleMax = useCallback((id: string) => {
    setWins((ws) => {
      const z = topZ(ws);
      return ws.map((w) => (w.id === id ? { ...w, max: !w.max, min: false, z } : w));
    });
    setFocused(id);
  }, []);

  const move = useCallback((id: string, r: Partial<Pick<Win, "x" | "y" | "w" | "h">>) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setWins((ws) => ws.map((w) => (w.id === id ? clampWin({ ...w, ...r, max: false }, vw, vh, insetsRef.current) : w)));
  }, []);

  const navigate = useCallback(
    (id: string, href: string, mode: "push" | "replace") => {
      const route = routeOf(href);
      if (!route) {
        const path = pathOf(href);
        if (path && DESKTOP_PATHS.has(path)) return showDesktop();
        return leave(href);
      }
      // a link to another app opens (or raises) that app's window; this one keeps its page
      const self = winsRef.current.find((w) => w.id === id);
      if (self && routeOf(current(self))?.app.key !== route.app.key) return open(href);
      setWins((ws) =>
        ws.map((w) => {
          if (w.id !== id) return w;
          if (mode === "replace") return { ...w, history: w.history.map((h, i) => (i === w.at ? href : h)) };
          const history = [...w.history.slice(0, w.at + 1), href];
          return { ...w, history, at: history.length - 1 };
        }),
      );
    },
    [open, showDesktop],
  );

  const back = useCallback((id: string) => {
    setWins((ws) => ws.map((w) => (w.id === id && w.at > 0 ? { ...w, at: w.at - 1 } : w)));
  }, []);

  // the layout survives reloads on this device (written once things settle, not on every pointer move of a drag)
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(keyFor(userId), JSON.stringify(wins.map((w) => ({ id: w.id, path: current(w), x: w.x, y: w.y, w: w.w, h: w.h, z: w.z, min: w.min, max: w.max }))));
      } catch {
        /* storage blocked */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [wins, userId]);

  // the address bar shows the focused window, so a reload or a shared link reopens it
  const focused = wins.find((w) => w.id === focusedId && !w.min);
  const address = focused ? current(focused) : "/office";
  useEffect(() => {
    if (`${location.pathname}${location.search}` !== address) window.history.replaceState(null, "", address);
  }, [address]);

  // a link to a page (or a reload of one) opens its window over the saved layout; a first visit opens the dashboard
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const path = pathOf(initialPath);
    if (routeOf(initialPath)) open(initialPath);
    else if (!winsRef.current.length && !(path && DESKTOP_PATHS.has(path))) open("/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep windows on screen when the browser window or the top bar changes size
  useEffect(() => {
    const fit = () => setWins((ws) => ws.map((w) => clampWin(w, window.innerWidth, window.innerHeight, insetsRef.current)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [insets.top, insets.bottom]);

  const value = useMemo<WindowManager>(
    () => ({ wins, focusedId, insets, open, close, focus, minimize, toggleMax, move, navigate, back, showDesktop }),
    [wins, focusedId, insets, open, close, focus, minimize, toggleMax, move, navigate, back, showDesktop],
  );
  const desk = useMemo<DesktopNav>(() => ({ handles: (href) => !!routeOf(href) || DESKTOP_PATHS.has(pathOf(href) ?? ""), open }), [open]);
  return (
    <Ctx.Provider value={value}>
      <DesktopContext.Provider value={desk}>{children}</DesktopContext.Provider>
    </Ctx.Provider>
  );
}
