"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Armchair, LayoutGrid, Monitor, Plus, UserPlus } from "lucide-react";
import { AccountMenu, Banners, KillSwitch, Notifications, ThemeToggle } from "@/components/layout/app-shell";
import { useOffice, type OfficePerson, type OfficeState } from "@/components/office/use-office";
import type { Office3DProps } from "@/components/office/office-3d";
import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { BotAvatar, type BotMood } from "@/components/ui/bot-avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useRealtimeStatus } from "@/lib/events";
import { useEmployees, useMe } from "@/lib/hooks";
import { employeeLooks, signVars } from "@/lib/sign";
import { cn } from "@/lib/utils";
import { APPS, routeOf, type AppGroup, type DesktopApp } from "./routes";
import { DesktopWindow } from "./window";
import { WindowProvider, current, useWindows } from "./windows";

const Office3D = dynamic<Office3DProps>(() => import("@/components/office/office-3d"), { ssr: false });

/** room kept free under the windows for the dock */
const DOCK_SPACE = 96;
const GROUPS: AppGroup[] = ["work", "team", "operations", "system"];
const WORKING = new Set(["typing", "reading", "terminal", "thinking"]);
const MOOD: Record<string, BotMood> = { typing: "working", reading: "working", terminal: "working", thinking: "working", waiting: "approval", paused: "off", idle: "idle" };
const STAFF_SHOWN = 8;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function usePendingApprovals(): number {
  const { data } = useQuery({
    queryKey: ["approvals", "pending-count"],
    queryFn: () => api.get<{ approvals: unknown[] }>("/api/approvals?status=PENDING").then((r) => r.approvals.length),
  });
  return data ?? 0;
}

/**
 * The desktop: the live 3D office fills the screen; app pages open as windows over it; a menu bar on top and a dock
 * at the bottom. Phones and tablets (and anyone who picks it) get the classic layout instead (see AppShell).
 */
export function Desktop({ onClassic }: { onClassic: () => void }) {
  const { data: me } = useMe();
  const ready = !!me;
  const top = useRef<HTMLDivElement>(null);
  const [topH, setTopH] = useState(40);
  const [initialPath] = useState(() => `${window.location.pathname}${window.location.search}`);
  useEffect(() => {
    const el = top.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTopH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  // the page itself never scrolls while the desktop is up (only while it is: sign-in pages scroll as usual)
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, []);
  const insets = useMemo(() => ({ top: topH, bottom: DOCK_SPACE }), [topH]);
  // the window layout is kept per person, so it waits for who that is
  if (!me) return <div className="fixed inset-0 bg-background" />;
  return (
    <WindowProvider initialPath={initialPath} insets={insets} userId={me.user.id}>
      <Screen topRef={top} onClassic={onClassic} />
    </WindowProvider>
  );
}

function Screen({ topRef, onClassic }: { topRef: RefObject<HTMLDivElement | null>; onClassic: () => void }) {
  const t = useTranslations("desktop");
  const to = useTranslations("office");
  const tn = useTranslations("nav");
  const wm = useWindows();
  const state = useOffice(to("generalRoom"));
  const reducedMotion = useReducedMotion();
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [officeOk, setOfficeOk] = useState(true);
  const [launcher, setLauncher] = useState(false);
  const [newTask, setNewTask] = useState(false);

  // Ctrl/⌘ K: a new task from anywhere on the desktop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setNewTask(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const flyTo = (id: string) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  const showOffice = () => {
    wm.showDesktop();
    flyTo("home");
  };
  // the office stops rendering while a maximized window hides it
  const covered = wm.wins.some((w) => w.max && !w.min);
  const labels = {
    lounge: to("lounge"),
    reception: to("reception"),
    activity: (p: OfficePerson) => to(`activity.${state.activityOf(p)}`),
  };
  void state.version; // the people map changes in place; version bumps re-read it
  const people = [...state.people.current.values()];
  const working = people.filter((p) => WORKING.has(state.activityOf(p))).length;
  const waiting = people.filter((p) => state.activityOf(p) === "waiting").length;

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      {/* the office, as the wallpaper */}
      <div className="absolute inset-0 z-0">
        {officeOk ? (
          <Office3D
            variant="wallpaper"
            state={state}
            labels={labels}
            reducedMotion={reducedMotion}
            paused={covered}
            focus={focus}
            onSelect={(p) => wm.open(p.task ? `/tasks/${p.task.id}` : `/employees/${p.id}`)}
            onUnavailable={() => setOfficeOk(false)}
          />
        ) : (
          <div className="grid h-full place-items-center bg-[radial-gradient(120%_90%_at_50%_70%,var(--secondary),var(--background))] p-8 text-center text-sm text-muted-foreground">{t("office.unavailable")}</div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {t("office.summary", { working, waiting })}
      </p>

      <div ref={topRef} className="fixed inset-x-0 top-0 z-40">
        <MenuBar state={state} people={people} onLauncher={() => setLauncher(true)} onNewTask={() => setNewTask(true)} onShowOffice={showOffice} onFly={flyTo} onClassic={onClassic} />
        <Banners />
      </div>

      <div className="pointer-events-none fixed inset-0 z-20">
        {wm.wins.map((w) => (
          <DesktopWindow key={w.id} w={w} focused={w.id === wm.focusedId} />
        ))}
      </div>

      <Dock onLauncher={() => setLauncher(true)} onShowOffice={showOffice} />

      <Dialog open={launcher} onOpenChange={setLauncher}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-3xl">{t("launcher.title")}</DialogTitle>
            <DialogDescription>{t("launcher.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            {GROUPS.map((g) => (
              <section key={g}>
                <h3 className="font-display mb-2 text-sm tracking-[0.12em] text-muted-foreground">{t(`launcher.groups.${g}`)}</h3>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {APPS.filter((a) => a.group === g).map((a) => (
                    <LauncherItem
                      key={a.key}
                      app={a}
                      label={tn(`items.${a.key}`)}
                      onClick={() => {
                        setLauncher(false);
                        wm.open(a.href);
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <QuickAction
                icon={<Plus className="size-4" />}
                label={t("launcher.newTask")}
                kbd="Ctrl K"
                onClick={() => {
                  setLauncher(false);
                  setNewTask(true);
                }}
              />
              <QuickAction
                icon={<UserPlus className="size-4" />}
                label={t("launcher.hire")}
                onClick={() => {
                  setLauncher(false);
                  wm.open("/employees/hire");
                }}
              />
              <QuickAction icon={<Monitor className="size-4" />} label={t("launcher.classic")} onClick={onClassic} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <NewTaskDialog open={newTask} onOpenChange={setNewTask} />
    </div>
  );
}

function LauncherItem({ app, label, onClick }: { app: DesktopApp; label: string; onClick: () => void }) {
  const Icon = app.icon;
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-3 rounded-xl p-2 text-left text-sm font-semibold hover:bg-secondary">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px]", app.color ? "sign" : "bg-secondary text-foreground")} data-state="lit" style={app.color ? signVars(app.color) : undefined}>
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function QuickAction({ icon, label, onClick, kbd }: { icon: ReactNode; label: string; onClick: () => void; kbd?: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-9 items-center gap-2 rounded-lg border bg-secondary/60 px-3 text-sm font-semibold hover:bg-secondary">
      {icon}
      {label}
      {kbd && <kbd className="rounded border bg-background px-1 font-mono text-[10px] text-muted-foreground">{kbd}</kbd>}
    </button>
  );
}

function MenuBar({
  state,
  people,
  onLauncher,
  onNewTask,
  onShowOffice,
  onFly,
  onClassic,
}: {
  state: OfficeState;
  people: OfficePerson[];
  onLauncher: () => void;
  onNewTask: () => void;
  onShowOffice: () => void;
  onFly: (id: string) => void;
  onClassic: () => void;
}) {
  const t = useTranslations("desktop");
  const to = useTranslations("office");
  const tn = useTranslations("nav");
  const wm = useWindows();
  const live = useRealtimeStatus();
  const { data: me } = useMe();
  const { data: emps } = useEmployees();
  const pending = usePendingApprovals();
  const deck = useMemo(() => employeeLooks(emps ?? []), [emps]);
  const focused = wm.wins.find((w) => w.id === wm.focusedId && !w.min);
  const app = focused ? routeOf(current(focused))?.app : undefined;
  const shown = people.slice(0, STAFF_SHOWN);
  const menuBtn = "rounded-md px-2.5 py-1 text-[13px] hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <header className="flex h-10 items-center gap-3 border-b bg-background/75 px-3 backdrop-blur-xl">
      <button type="button" onClick={onLauncher} className="flex shrink-0 items-center gap-2" aria-label={t("menubar.apps")}>
        <span className="sign grid size-6 place-items-center rounded-md" data-state="lit">
          <span className="font-display text-[0.95rem]" aria-hidden>
            {/* i18n-ignore: the brand mark, not a word */}
            W
          </span>
        </span>
        <span className="font-display max-w-48 truncate text-lg">{me?.workspace.name ?? ""}</span>
      </button>
      <nav className="flex min-w-0 items-center gap-0.5">
        <span className="px-2 text-[13px] font-bold">{app ? tn(`items.${app.key}`) : t("menubar.office")}</span>
        <button type="button" className={menuBtn} onClick={onLauncher}>
          {t("menubar.apps")}
        </button>
        <button type="button" className={menuBtn} onClick={onNewTask}>
          {t("menubar.command")}
        </button>
        <button type="button" className={menuBtn} onClick={onShowOffice}>
          {t("menubar.showOffice")}
        </button>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {!!people.length && (
          <div role="group" aria-label={t("menubar.staff")} className="hidden items-center gap-0.5 xl:flex">
            {shown.map((p) => {
              const act = state.activityOf(p);
              return (
                <button key={p.id} type="button" onClick={() => onFly(p.id)} title={`${p.name} · ${to(`activity.${act}`)}`} aria-label={`${p.name} · ${to(`activity.${act}`)}`} className="size-7 rounded-md p-0.5 hover:bg-secondary">
                  <BotAvatar shape={deck.shapes.get(p.id) ?? "cercle"} color={deck.colors.get(p.id)} expression={deck.expressions.get(p.id)} mood={MOOD[act] ?? "idle"} seed={p.id} />
                </button>
              );
            })}
            {people.length > shown.length && <span className="px-1 text-xs text-muted-foreground">{t("menubar.staffMore", { count: people.length - shown.length })}</span>}
          </div>
        )}
        <button
          type="button"
          onClick={() => wm.open("/approvals")}
          className={cn("inline-flex h-7 items-center rounded-full px-3 text-xs font-bold", pending ? "approval-strip" : "bg-secondary text-muted-foreground")}
        >
          {t("menubar.approvals", { count: pending })}
        </button>
        <span className={cn("size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/50")} title={live ? tn("live.connected") : tn("live.connecting")} aria-hidden />
        <Notifications buttonClassName="size-8" />
        <ThemeToggle className="size-8" />
        <div className="[&_button]:h-7">
          <KillSwitch placement="header" />
        </div>
        <AccountMenu view={{ label: t("menubar.classic"), onSelect: onClassic }} triggerClassName="size-8" />
      </div>
    </header>
  );
}

function Dock({ onLauncher, onShowOffice }: { onLauncher: () => void; onShowOffice: () => void }) {
  const t = useTranslations("desktop");
  const tn = useTranslations("nav.items");
  const wm = useWindows();
  const pending = usePendingApprovals();
  const windowOf = (a: DesktopApp) => wm.wins.find((w) => routeOf(current(w))?.app.key === a.key);
  // a dock tile raises its app's window as it was left; clicking the front window's tile minimizes it
  const click = (a: DesktopApp) => {
    const w = windowOf(a);
    if (!w) return wm.open(a.href);
    if (w.id === wm.focusedId && !w.min) wm.minimize(w.id);
    else wm.focus(w.id);
  };
  return (
    <nav aria-label={t("dock.label")} className="fixed bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-end gap-2 rounded-[22px] border bg-background/70 p-2 shadow-[0_18px_40px_-12px_rgb(10_6_14/0.5)] backdrop-blur-xl">
      <DockTile label={t("dock.allApps")} onClick={onLauncher} neutral>
        <LayoutGrid className="size-6" />
      </DockTile>
      <span className="mx-0.5 h-10 w-px self-center bg-border" aria-hidden />
      {APPS.filter((a) => a.dock).map((a) => {
        const Icon = a.icon;
        return (
          <DockTile key={a.key} label={tn(a.key)} onClick={() => click(a)} style={a.color ? signVars(a.color) : undefined} neutral={!a.color} running={!!windowOf(a)} runningLabel={t("dock.running")} badge={a.key === "approvals" ? pending : 0}>
            <Icon className="size-6" />
          </DockTile>
        );
      })}
      <span className="mx-0.5 h-10 w-px self-center bg-border" aria-hidden />
      <DockTile label={t("dock.showOffice")} onClick={onShowOffice} neutral>
        <Armchair className="size-6" />
      </DockTile>
    </nav>
  );
}

function DockTile({
  label,
  onClick,
  children,
  style,
  neutral,
  running,
  runningLabel,
  badge = 0,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
  neutral?: boolean;
  running?: boolean;
  runningLabel?: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={running && runningLabel ? `${label} (${runningLabel})` : label}
      className="group relative grid size-12 shrink-0 place-items-center rounded-[14px] transition-transform duration-150 ease-out hover:-translate-y-2 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:transform-none"
    >
      <span className={cn("grid size-full place-items-center rounded-[14px]", neutral ? "bg-secondary text-foreground ring-1 ring-border" : "sign")} data-state="lit" style={style}>
        {children}
      </span>
      <span className="pointer-events-none absolute -top-9 whitespace-nowrap rounded-md border bg-popover px-2 py-0.5 text-xs font-semibold text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {label}
      </span>
      {!!badge && <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-approval px-1 text-center text-[11px] font-bold leading-5 text-approval-ink">{badge}</span>}
      {running && <span className="absolute -bottom-1.5 size-1 rounded-full bg-foreground" aria-hidden />}
    </button>
  );
}
