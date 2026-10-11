"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bell,
  Armchair,
  Bot,
  BookOpen,
  Building2,
  CalendarClock,
  CheckCircle2,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  Menu,
  Languages,
  MessageSquare,
  Moon,
  OctagonX,
  Settings,
  ShieldCheck,
  UserRound,
  Sun,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { EventsProvider, useRealtime, useRealtimeStatus } from "@/lib/events";
import { useMe } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { QuotaBanner } from "@/components/inspector/limits-card";
import { useTranslations } from "next-intl";
import { LOCALES, LOCALE_NAMES } from "@wfos/shared";
import { cn } from "@/lib/utils";
import { approvalKeys, decidePush, isPushMessage, RecentToasts } from "@/lib/push-toast";

const NAV = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/employees", key: "employees", icon: Bot },
  { href: "/teams", key: "teams", icon: UsersRound },
  { href: "/office", key: "office", icon: Armchair },
  { href: "/chat", key: "chat", icon: MessageSquare },
  { href: "/tasks", key: "tasks", icon: KanbanSquare },
  { href: "/routines", key: "routines", icon: CalendarClock },
  { href: "/approvals", key: "approvals", icon: ShieldCheck, badge: "approvals" as const },
  { href: "/clients", key: "clients", icon: Building2 },
  { href: "/knowledge", key: "knowledge", icon: BookOpen },
  { href: "/settings", key: "settings", icon: Settings },
] as const;

/**
 * `rail`: the desktop icon rail (icon over a short label, like the shop signs' row); `list`: the phone menu.
 * The approvals count is the one number the rail always shows.
 */
function Nav({ onNavigate, layout }: { onNavigate?: () => void; layout: "rail" | "list" }) {
  const t = useTranslations("nav");
  const path = usePathname();
  const { data } = useQuery({
    queryKey: ["approvals", "pending-count"],
    queryFn: () => api.get<{ approvals: unknown[] }>("/api/approvals?status=PENDING").then((r) => r.approvals.length),
  });
  return (
    <nav className={layout === "rail" ? "flex flex-col items-center gap-1" : "space-y-0.5"}>
      {NAV.map((n) => {
        const active = path === n.href || path.startsWith(`${n.href}/`);
        const count = "badge" in n && !!data ? data : 0;
        if (layout === "rail")
          return (
            <Link
              key={n.href}
              href={n.href}
              title={t(`items.${n.key}`)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex w-[5.5rem] flex-col items-center gap-1 rounded-xl px-1 pb-1.5 pt-2 text-[11px] font-semibold leading-tight transition-colors",
                active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <n.icon className="size-[18px]" aria-hidden />
              <span className="max-w-full truncate">{t(`rail.${n.key}`)}</span>
              {!!count && (
                <span className="absolute right-2.5 top-1 min-w-4 rounded-full bg-approval px-1 text-center text-[10px] font-bold leading-4 text-approval-ink">
                  <span className="sr-only">{t(`items.${n.key}`)}: </span>
                  {count}
                </span>
              )}
            </Link>
          );
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors",
              active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <n.icon className="size-[18px]" aria-hidden />
            <span className="flex-1">{t(`items.${n.key}`)}</span>
            {!!count && <span className="rounded-full bg-approval px-2 text-xs font-bold leading-5 text-approval-ink">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function KillSwitch({ placement }: { placement: "rail" | "header" }) {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const engaged = !!me?.workspace.killSwitch;
  const m = useMutation({
    mutationFn: (v: boolean) => api.post("/api/killswitch", { engaged: v, reason }),
    onSuccess: (_d, v) => {
      toast[v ? "error" : "success"](v ? t("killSwitch.engagedToast") : t("killSwitch.releasedToast"));
      setOpen(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") return null;
  return (
    <>
      {placement === "rail" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={engaged ? t("killSwitch.release") : t("killSwitch.button")}
          className={cn(
            "flex w-[5.5rem] flex-col items-center gap-1 rounded-xl px-1 pb-1.5 pt-2 text-[11px] font-semibold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            engaged ? "bg-destructive text-white" : "bg-destructive/12 text-destructive hover:bg-destructive/20",
          )}
        >
          <OctagonX className="size-[18px]" aria-hidden />
          {engaged ? t("killSwitch.releaseConfirm") : t("killSwitch.short")}
        </button>
      ) : (
        <Button size="sm" variant={engaged ? "default" : "destructive"} onClick={() => setOpen(true)} className="gap-1.5">
          <OctagonX className="size-4" />
          <span className="hidden sm:inline">{engaged ? t("killSwitch.release") : t("killSwitch.button")}</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{engaged ? t("killSwitch.releaseTitle") : t("killSwitch.engageTitle")}</DialogTitle>
            <DialogDescription>
              {engaged ? t("killSwitch.releaseDescription") : t("killSwitch.engageDescription")}
            </DialogDescription>
          </DialogHeader>
          {!engaged && <Textarea placeholder={t("killSwitch.reasonPlaceholder")} value={reason} onChange={(e) => setReason(e.target.value)} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant={engaged ? "default" : "destructive"} disabled={m.isPending} onClick={() => m.mutate(!engaged)}>
              {engaged ? t("killSwitch.releaseConfirm") : t("killSwitch.engageConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Notifications() {
  const t = useTranslations("nav");
  const f = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ notifications: { id: string; title: string; body: string; link: string | null; createdAt: string; read: boolean }[]; unread: number }>("/api/notifications"),
    refetchInterval: 60_000,
  });
  const recent = useRef(new RecentToasts());
  // the service worker offers pushes to visible windows first: a focused one shows a toast and ACKs (no system
  // notification); otherwise it says no and the system notification shows (see lib/push-toast)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (ev: MessageEvent) => {
      if (!isPushMessage(ev.data)) return;
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      const focused = document.visibilityState === "visible" && document.hasFocus();
      const d = decidePush(ev.data, focused, recent.current);
      ev.ports[0]?.postMessage({ ack: d.ack });
      if (d.ack && d.toast) {
        const { url } = d.toast;
        toast.info(d.toast.title, { id: d.toast.id, description: d.toast.body, action: { label: t("live.open"), onClick: () => router.push(url) } });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [qc, router, t]);
  useRealtime((ev) => {
    if (ev.type === "approval.created") {
      // one toast per approval, whether its push or its realtime event came first
      const keys = approvalKeys(ev.approvalId, ev.conversationId);
      const id = recent.current.find(keys) ?? `approval:${ev.approvalId}`;
      recent.current.mark(keys, id);
      toast.warning(t("live.approvalNeeded", { title: ev.title }), { id, action: { label: t("live.open"), onClick: () => (location.href = "/approvals") } });
    }
    if (ev.type === "task.updated" && ev.status === "FAILED") toast.error(ev.title ? t("live.taskFailedNamed", { title: ev.title }) : t("live.taskFailed"));
    if (ev.type === "demo.stage") toast.info(ev.detail);
    if (ev.type === "employee.updated" && ev.status === "PAUSED_BUDGET") toast.warning(t("live.employeePausedBudget"));
    if (ev.type === "limits.warning") toast.warning(t("live.limitWarning", { pct: ev.threshold }));
    if (ev.type === "quota.paused") toast.error(t("live.quotaPaused"));
    if (ev.type === "approval.created" || ev.type === "task.updated") void qc.invalidateQueries({ queryKey: ["notifications"] });
  });
  const markRead = useMutation({ mutationFn: () => api.post("/api/notifications"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <Popover onOpenChange={(o) => !o && data?.unread && markRead.mutate()}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="relative" aria-label={t("notifications.title")}>
          <Bell className="size-4" />
          {!!data?.unread && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-approval" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">{t("notifications.title")}</div>
        <div className="max-h-96 overflow-y-auto">
          {!data?.notifications.length && <p className="p-4 text-sm text-muted-foreground">{t("notifications.empty")}</p>}
          {data?.notifications.map((n) => (
            <Link key={n.id} href={n.link ?? "#"} className={cn("block border-b px-3 py-2 text-sm hover:bg-accent", !n.read && "bg-primary/5")}>
              <div className="font-medium">{n.title}</div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{n.body}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{f.ago(n.createdAt)}</div>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThemeToggle() {
  const t = useTranslations("nav");
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={t("toggleTheme")}
      onClick={() => {
        const dark = document.documentElement.classList.toggle("dark");
        try {
          localStorage.setItem("wfos-theme", dark ? "dark" : "light");
        } catch {
          /* storage blocked */
        }
      }}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const ts = useTranslations("status");
  const router = useRouter();
  const { data: me } = useMe();
  const live = useRealtimeStatus();
  const [mobile, setMobile] = useState(false);
  // full-height pages (chat) size themselves to the viewport minus this: the header plus whatever banners show
  const chrome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chrome.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--chrome", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const brand = (
    <Link href="/dashboard" aria-label="Workforce OS" className="sign flex size-11 items-center justify-center rounded-xl" data-state="lit">
      <span className="font-display text-[1.45rem]" aria-hidden>
        {/* i18n-ignore: the brand mark, not a word */}
        W
      </span>
    </Link>
  );
  const liveDot = (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
      <span className={cn("size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/50")} aria-hidden /> {live ? t("live.connected") : t("live.connecting")}
    </span>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[6.25rem] shrink-0 flex-col items-center gap-4 overflow-y-auto border-r bg-sidebar py-4 [scrollbar-width:none] lg:flex">
        {brand}
        <Nav layout="rail" />
        <div className="mt-auto flex flex-col items-center gap-3">
          <KillSwitch placement="rail" />
          <span className={cn("size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/50")} title={live ? t("live.connected") : t("live.connecting")} aria-hidden />
        </div>
      </aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          <SheetTitle className="sr-only">{t("navigation")}</SheetTitle>
          <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
            <div className="flex items-center gap-3">
              {brand}
              <div className="min-w-0">
                <div className="font-display truncate text-xl">{me?.workspace.name ?? "Workforce OS"}</div>
                {liveDot}
              </div>
            </div>
            <Nav layout="list" onNavigate={() => setMobile(false)} />
            <Link href="/account" onClick={() => setMobile(false)} className="mt-auto block rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground hover:text-foreground">
              <span className="block truncate text-sm font-semibold text-foreground">{me?.user.name}</span>
              <span className="block truncate">
                {me?.user.email} · {me ? ts(`role.${me.role}`) : ""}
              </span>
            </Link>
          </div>
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={chrome} className="sticky top-0 z-30">
        <header className="flex h-14 items-center gap-2 border-b bg-background px-4 sm:px-6 lg:px-8">
          <Button size="icon" variant="ghost" className="lg:hidden" onClick={() => setMobile(true)} aria-label={t("menu")}>
            <Menu className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <span className="font-display block truncate text-xl">{me?.workspace.name ?? ""}</span>
          </div>
          <div className="lg:hidden">
            <KillSwitch placement="header" />
          </div>
          <Notifications />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="rounded-full" aria-label={t("accountMenu")}>
                <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground ring-1 ring-border">
                  {(me?.user.name ?? "?").trim().charAt(0).toUpperCase()}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="truncate text-sm font-medium">{me?.user.name}</div>
                <div className="truncate text-xs text-muted-foreground">{me?.user.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <UserRound className="size-4" /> {t("account")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings">
                  <Settings className="size-4" /> {t("workspaceSettings")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("language")}</DropdownMenuLabel>
              {LOCALES.map((l) => (
                <DropdownMenuItem
                  key={l}
                  onSelect={async () => {
                    await api.patch("/api/me", { locale: l });
                    window.location.reload();
                  }}
                >
                  <Languages className="size-4" /> {LOCALE_NAMES[l]}
                  {me?.user.locale === l && <CheckCircle2 className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  await api.post("/api/auth/logout");
                  router.replace("/login");
                }}
              >
                <LogOut className="size-4" /> {t("signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <QuotaBanner />
        {me?.workspace.killSwitch && (
          <div className="flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-semibold text-white sm:px-6 lg:px-8">
            <OctagonX className="size-4" /> {t("killSwitch.banner")}
          </div>
        )}
        {me?.workspace.demoMode && (
          <div className="flex items-center gap-2 border-b bg-secondary px-4 py-1.5 text-sm sm:px-6 lg:px-8">
            <span className="shrink-0 rounded-md bg-[var(--sign-ungu)] px-1.5 text-xs font-bold leading-5 text-white">{t("demoChip")}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{t("demoBanner")}</span>
            <Link href="/settings" className="shrink-0 font-semibold underline underline-offset-2">
              {t("turnOff")}
            </Link>
          </div>
        )}
        {me && !me.claude.credentialPresent && !me.workspace.demoMode && (
          <div className="bg-warning/15 px-4 py-1.5 text-sm text-warning sm:px-6 lg:px-8">
            {t.rich("noCredentialBanner", {
              link: (c) => (
                <Link href="/settings" className="underline underline-offset-2">
                  {c}
                </Link>
              ),
            })}
          </div>
        )}
        </div>
        <main className="mx-auto w-full max-w-[1520px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <EventsProvider>
      <Shell>{children}</Shell>
    </EventsProvider>
  );
}
