import { Bot, BookOpen, Building2, CalendarClock, KanbanSquare, LayoutDashboard, MessageSquare, Rocket, Send, Settings, ShieldCheck, Target, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import type { SignColor } from "@/lib/sign";

/**
 * The desktop's apps: every app page the shell can show in a window, its dock tile (an acrylic sign in its colour)
 * and the size its window opens at. The page modules themselves are loaded in pages.tsx.
 */

export const PAGE_KEYS = ["dashboard", "chat", "tasks", "task", "approvals", "outbox", "employees", "hire", "employee", "teams", "goals", "routines", "clients", "client", "apps", "app", "uiTemplates", "knowledge", "settings", "account"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export type AppKey = "dashboard" | "chat" | "tasks" | "approvals" | "outbox" | "employees" | "teams" | "goals" | "routines" | "clients" | "apps" | "knowledge" | "settings" | "account";
export type AppGroup = "work" | "team" | "operations" | "system";

export interface DesktopApp {
  key: AppKey;
  href: string;
  icon: LucideIcon;
  /** dock tile colour; null is a neutral tile */
  color: SignColor | null;
  group: AppGroup;
  dock: boolean;
  /** window size when it first opens (clamped to the screen) */
  size: [number, number];
}

export const APPS: readonly DesktopApp[] = [
  { key: "dashboard", href: "/dashboard", icon: LayoutDashboard, color: "biru", group: "work", dock: true, size: [1080, 740] },
  { key: "chat", href: "/chat", icon: MessageSquare, color: "tosca", group: "work", dock: true, size: [1200, 800] },
  { key: "tasks", href: "/tasks", icon: KanbanSquare, color: "ungu", group: "work", dock: true, size: [1260, 780] },
  { key: "approvals", href: "/approvals", icon: ShieldCheck, color: "kuning", group: "work", dock: true, size: [900, 740] },
  { key: "outbox", href: "/outbox", icon: Send, color: "hijau", group: "work", dock: true, size: [1080, 760] },
  { key: "employees", href: "/employees", icon: Bot, color: "oranye", group: "team", dock: true, size: [1120, 760] },
  { key: "teams", href: "/teams", icon: UsersRound, color: "magenta", group: "team", dock: true, size: [1240, 800] },
  { key: "goals", href: "/goals", icon: Target, color: "kuning", group: "operations", dock: false, size: [1000, 760] },
  { key: "routines", href: "/routines", icon: CalendarClock, color: "hijau", group: "operations", dock: true, size: [1040, 720] },
  { key: "clients", href: "/clients", icon: Building2, color: "merah", group: "operations", dock: true, size: [1080, 740] },
  { key: "apps", href: "/apps", icon: Rocket, color: "biru", group: "operations", dock: true, size: [1120, 780] },
  { key: "knowledge", href: "/knowledge", icon: BookOpen, color: "biru", group: "operations", dock: false, size: [1040, 720] },
  { key: "settings", href: "/settings", icon: Settings, color: null, group: "system", dock: false, size: [1100, 780] },
  { key: "account", href: "/account", icon: UserRound, color: null, group: "system", dock: false, size: [900, 720] },
];
export const APP_BY_KEY = new Map(APPS.map((a) => [a.key, a]));

/** which page a path shows: its app (dock tile, window title), the page component and its route params */
export interface Route {
  app: DesktopApp;
  page: PageKey;
  /** a detail page under the app (task, employee, hire, client, app): named next to the app in the title bar */
  detail: "task" | "employee" | "hire" | "client" | "app" | "uiTemplates" | null;
  params: Record<string, string>;
}

const TABLE: { re: RegExp; app: AppKey; page: PageKey; detail?: Route["detail"]; param?: string }[] = [
  { re: /^\/dashboard$/, app: "dashboard", page: "dashboard" },
  { re: /^\/chat$/, app: "chat", page: "chat" },
  { re: /^\/tasks$/, app: "tasks", page: "tasks" },
  { re: /^\/tasks\/([^/]+)$/, app: "tasks", page: "task", detail: "task", param: "id" },
  { re: /^\/approvals$/, app: "approvals", page: "approvals" },
  { re: /^\/outbox$/, app: "outbox", page: "outbox" },
  { re: /^\/employees$/, app: "employees", page: "employees" },
  { re: /^\/employees\/hire$/, app: "employees", page: "hire", detail: "hire" },
  { re: /^\/employees\/([^/]+)$/, app: "employees", page: "employee", detail: "employee", param: "id" },
  { re: /^\/teams$/, app: "teams", page: "teams" },
  { re: /^\/goals$/, app: "goals", page: "goals" },
  { re: /^\/routines$/, app: "routines", page: "routines" },
  { re: /^\/clients$/, app: "clients", page: "clients" },
  { re: /^\/clients\/([^/]+)$/, app: "clients", page: "client", detail: "client", param: "id" },
  { re: /^\/apps$/, app: "apps", page: "apps" },
  { re: /^\/apps\/templates$/, app: "apps", page: "uiTemplates", detail: "uiTemplates" },
  { re: /^\/apps\/([^/]+)$/, app: "apps", page: "app", detail: "app", param: "id" },
  { re: /^\/knowledge$/, app: "knowledge", page: "knowledge" },
  { re: /^\/settings$/, app: "settings", page: "settings" },
  { re: /^\/account$/, app: "account", page: "account" },
];

/** a same-origin path the browser may be sent to (never "//host", "javascript:" or another site) */
export function isLocalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
}

/** the path part of an in-app href ("/tasks/abc?x=1#y" → "/tasks/abc"); null for other origins or relative links */
export function pathOf(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  return href.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
}

export function routeOf(href: string): Route | null {
  const path = pathOf(href);
  if (!path) return null;
  for (const r of TABLE) {
    const m = r.re.exec(path);
    if (!m) continue;
    let params: Record<string, string> = {};
    try {
      if (r.param) params = { [r.param]: decodeURIComponent(m[1]!) };
    } catch {
      return null; // a malformed %-escape is not a page
    }
    return { app: APP_BY_KEY.get(r.app)!, page: r.page, detail: r.detail ?? null, params };
  }
  return null;
}
