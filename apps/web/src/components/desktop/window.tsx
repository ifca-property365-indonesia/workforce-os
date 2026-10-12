"use client";

import { Component, memo, Suspense, useEffect, useMemo, useRef, type ErrorInfo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { WindowNavContext, type WindowNav } from "@/lib/nav";
import { signVars } from "@/lib/sign";
import { cn } from "@/lib/utils";
import { pageComponent } from "./pages";
import { routeOf } from "./routes";
import { current, useWindows, type Win } from "./windows";

/** one page's crash stays inside its window */
class WindowBoundary extends Component<{ fallback: (reset: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("window crashed", error, info.componentStack);
  }
  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

function Loading() {
  const t = useTranslations("desktop.window");
  return <p className="p-6 text-sm text-muted-foreground">{t("loading")}</p>;
}

/** the page a window shows, with its route params as the promise Next would pass; it re-renders only when its path does */
const WindowPage = memo(function WindowPage({ path }: { path: string }) {
  const route = routeOf(path);
  const key = route ? JSON.stringify(route.params) : "";
  const params = useMemo(() => Promise.resolve(route?.params ?? {}), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!route) return null;
  const Page = pageComponent(route.page);
  return <Page params={params} />;
});

export const DesktopWindow = memo(function DesktopWindow({ w, focused }: { w: Win; focused: boolean }) {
  const t = useTranslations("desktop.window");
  const tn = useTranslations("nav.items");
  const wm = useWindows();
  const path = current(w);
  const route = routeOf(path);
  const app = route?.app;
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; x: number; y: number; w: number; h: number } | null>(null);

  // built from the manager's stable callbacks only, so moving a window doesn't re-render every page
  const { navigate, back } = wm;
  const nav = useMemo<WindowNav>(
    () => ({ path, push: (href) => navigate(w.id, href, "push"), replace: (href) => navigate(w.id, href, "replace"), back: () => back(w.id) }),
    [path, w.id, navigate, back],
  );
  const pathname = path.split(/[?#]/)[0]!;
  const frame = useRef<HTMLElement>(null);

  // pages sized to the viewport (chat: 100dvh − --chrome − padding) fit the window body instead
  useEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => el.style.setProperty("--chrome", `${Math.max(0, window.innerHeight - el.clientHeight - 16)}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener("resize", set);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", set);
    };
  }, []);

  // a new page in this window starts at its top (a changed query, like a filter, keeps the place)
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pathname]);

  // the window brought forward takes the keyboard focus, unless the focus is already inside it
  useEffect(() => {
    const el = frame.current;
    if (focused && !w.min && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [focused, w.min]);

  const start = (mode: "move" | "resize") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // dragging a maximized window restores it under the pointer
    if (mode === "move" && w.max) {
      const width = Math.min(w.w, window.innerWidth - 48);
      const x = e.clientX - width / 2;
      const y = wm.insets.top + 8;
      wm.move(w.id, { x, y, w: width });
      drag.current = { mode, sx: e.clientX, sy: e.clientY, x, y, w: width, h: w.h };
    } else drag.current = { mode, sx: e.clientX, sy: e.clientY, x: w.x, y: w.y, w: w.w, h: w.h };
    wm.focus(w.id);
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") wm.move(w.id, { x: d.x + dx, y: d.y + dy });
    else wm.move(w.id, { w: d.w + dx, h: d.h + dy });
  };
  const end = () => {
    drag.current = null;
  };
  const dragHandlers = { onPointerMove: onMove, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end };

  const title = app ? tn(app.key) : "";
  const detail = route?.detail ? t(`detail.${route.detail}`) : "";
  const style = w.max
    ? { left: 0, top: wm.insets.top, width: "100%", height: `calc(100% - ${wm.insets.top + wm.insets.bottom}px)`, zIndex: w.z }
    : { left: w.x, top: w.y, width: w.w, height: w.h, zIndex: w.z };

  return (
    <section
      ref={frame}
      tabIndex={-1}
      aria-label={detail ? `${title} · ${detail}` : title}
      aria-hidden={w.min || undefined}
      inert={w.min || undefined}
      onPointerDownCapture={() => !focused && wm.focus(w.id)}
      onFocusCapture={() => !focused && wm.focus(w.id)}
      style={style}
      className={cn(
        "pointer-events-auto absolute flex flex-col overflow-hidden border outline-none bg-background/95 shadow-[0_30px_80px_-20px_rgb(10_6_14/0.55)] backdrop-blur-xl transition-[opacity,transform] duration-200 motion-reduce:transition-none",
        w.max ? "rounded-none border-x-0" : "rounded-2xl",
        focused ? "border-foreground/15" : "border-border",
        w.min && "pointer-events-none translate-y-16 scale-95 opacity-0",
      )}
    >
      <header
        onPointerDown={start("move")}
        {...dragHandlers}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && wm.toggleMax(w.id)}
        className={cn("flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b bg-card/80 pl-3 active:cursor-grabbing", !focused && "opacity-80")}
      >
        <div className="group flex items-center gap-1.5 [&>button]:focus-visible:outline-none [&>button]:focus-visible:ring-2 [&>button]:focus-visible:ring-ring">
          <button type="button" onClick={() => wm.close(w.id)} aria-label={t("close")} title={t("close")} className="grid size-3.5 place-items-center rounded-full bg-destructive text-black/60">
            <X className="size-2.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" strokeWidth={3} />
          </button>
          <button type="button" onClick={() => wm.minimize(w.id)} aria-label={t("minimize")} title={t("minimize")} className="grid size-3.5 place-items-center rounded-full bg-approval text-black/60">
            <Minus className="size-2.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" strokeWidth={3} />
          </button>
          <button
            type="button"
            onClick={() => wm.toggleMax(w.id)}
            aria-label={w.max ? t("restore") : t("maximize")}
            title={w.max ? t("restore") : t("maximize")}
            className="grid size-3.5 place-items-center rounded-full bg-success text-black/60"
          >
            {w.max ? <Minimize2 className="size-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" strokeWidth={3} /> : <Maximize2 className="size-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" strokeWidth={3} />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => wm.back(w.id)}
          disabled={w.at === 0}
          aria-label={t("back")}
          title={t("back")}
          className="ml-1 grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-xs font-medium text-muted-foreground">{detail}</div>
        {app && (
          <span
            className={cn("font-display flex h-full items-center px-4 text-[1.05rem] tracking-wide", app.color ? "sign" : "bg-secondary text-foreground")}
            data-state="lit"
            style={app.color ? signVars(app.color) : undefined}
          >
            {title}
          </span>
        )}
      </header>
      <div ref={body} className="relative min-h-0 flex-1 overflow-auto px-5 py-5">
        <WindowNavContext.Provider value={nav}>
          <WindowBoundary
            key={pathname}
            fallback={(reset) => (
              <div className="grid h-full place-items-center p-6 text-center text-sm">
                <div className="space-y-3">
                  <p>{t("crashed")}</p>
                  <button type="button" onClick={reset} className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground">
                    {t("reload")}
                  </button>
                </div>
              </div>
            )}
          >
            <Suspense fallback={<Loading />}>
              <WindowPage path={path} />
            </Suspense>
          </WindowBoundary>
        </WindowNavContext.Provider>
      </div>
      {!w.max && <div onPointerDown={start("resize")} {...dragHandlers} aria-hidden className="absolute bottom-0 right-0 size-4 cursor-nwse-resize" />}
    </section>
  );
});
