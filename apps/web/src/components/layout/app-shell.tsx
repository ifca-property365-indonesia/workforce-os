"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bell,
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
  Users,
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
import { useTranslations } from "next-intl";
import { LOCALES, LOCALE_NAMES } from "@wfos/shared";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/employees", key: "employees", icon: Bot },
  { href: "/teams", key: "teams", icon: UsersRound },
  { href: "/chat", key: "chat", icon: MessageSquare },
  { href: "/tasks", key: "tasks", icon: KanbanSquare },
  { href: "/routines", key: "routines", icon: CalendarClock },
  { href: "/approvals", key: "approvals", icon: ShieldCheck, badge: "approvals" as const },
  { href: "/clients", key: "clients", icon: Building2 },
  { href: "/knowledge", key: "knowledge", icon: BookOpen },
  { href: "/settings", key: "settings", icon: Settings },
] as const;

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const path = usePathname();
  const { data } = useQuery({
    queryKey: ["approvals", "pending-count"],
    queryFn: () => api.get<{ approvals: unknown[] }>("/api/approvals?status=PENDING").then((r) => r.approvals.length),
  });
  return (
    <nav className="space-y-0.5">
      {NAV.map((n) => {
        const active = path === n.href || path.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <n.icon className="size-4" />
            <span className="flex-1">{t(`items.${n.key}`)}</span>
            {"badge" in n && !!data && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{data}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function KillSwitch() {
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
      <Button size="sm" variant={engaged ? "default" : "destructive"} onClick={() => setOpen(true)} className="gap-1.5">
        <OctagonX className="size-4" />
        <span className="hidden sm:inline">{engaged ? t("killSwitch.release") : t("killSwitch.button")}</span>
      </Button>
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
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ notifications: { id: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }[]; unread: number }>("/api/notifications"),
    refetchInterval: 60_000,
  });
  useRealtime((ev) => {
    if (ev.type === "approval.created") toast.warning(t("live.approvalNeeded", { title: ev.title }), { action: { label: t("live.open"), onClick: () => (location.href = "/approvals") } });
    if (ev.type === "task.updated" && ev.status === "FAILED") toast.error(ev.title ? t("live.taskFailedNamed", { title: ev.title }) : t("live.taskFailed"));
    if (ev.type === "demo.stage") toast.info(ev.detail);
    if (ev.type === "employee.updated" && ev.status === "PAUSED_BUDGET") toast.warning(t("live.employeePausedBudget"));
    if (ev.type === "approval.created" || ev.type === "task.updated") void qc.invalidateQueries({ queryKey: ["notifications"] });
  });
  const markRead = useMutation({ mutationFn: () => api.post("/api/notifications"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <Popover onOpenChange={(o) => !o && data?.unread && markRead.mutate()}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="relative" aria-label={t("notifications.title")}>
          <Bell className="size-4" />
          {!!data?.unread && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">{t("notifications.title")}</div>
        <div className="max-h-96 overflow-y-auto">
          {!data?.notifications.length && <p className="p-4 text-sm text-muted-foreground">{t("notifications.empty")}</p>}
          {data?.notifications.map((n) => (
            <Link key={n.id} href={n.link ?? "#"} className={cn("block border-b px-3 py-2 text-sm hover:bg-accent", !n.readAt && "bg-primary/5")}>
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

  const sidebar = (
    <div className="flex h-full flex-col gap-4 p-3">
      <Link href="/dashboard" className="flex items-center gap-2 px-2 pt-1 font-semibold">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-4" />
        </span>
        Workforce OS
      </Link>
      <Nav onNavigate={() => setMobile(false)} />
      <div className="mt-auto space-y-2 rounded-lg border bg-card p-3 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          <Users className="size-3.5" /> {me?.workspace.name ?? "…"}
        </div>
        <Link href="/account" onClick={() => setMobile(false)} className="block text-muted-foreground hover:text-foreground">
          <span className="block truncate font-medium text-foreground">{me?.user.name}</span>
          <span className="block truncate">
            {me?.user.email} · {me ? ts(`role.${me.role}`) : ""}
          </span>
        </Link>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-zinc-400")} /> {live ? t("live.connected") : t("live.connecting")}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-sidebar lg:block">{sidebar}</aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">{t("navigation")}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <Button size="icon" variant="ghost" className="lg:hidden" onClick={() => setMobile(true)} aria-label={t("menu")}>
            <Menu className="size-5" />
          </Button>
          <div className="flex-1" />
          <KillSwitch />
          <Notifications />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="rounded-full" aria-label={t("accountMenu")}>
                <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
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
        {me?.workspace.killSwitch && (
          <div className="flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-white">
            <OctagonX className="size-4" /> {t("killSwitch.banner")}
          </div>
        )}
        {me?.workspace.demoMode && (
          <div className="flex flex-wrap items-center gap-2 bg-violet-600 px-4 py-1.5 text-sm text-white">
            <CheckCircle2 className="size-4" /> {t("demoBanner")}
            <Link href="/settings" className="underline underline-offset-2">
              {t("turnOff")}
            </Link>
          </div>
        )}
        {me && !me.claude.credentialPresent && !me.workspace.demoMode && (
          <div className="bg-amber-500/15 px-4 py-1.5 text-sm text-amber-800 dark:text-amber-200">
            {t.rich("noCredentialBanner", {
              link: (c) => (
                <Link href="/settings" className="underline underline-offset-2">
                  {c}
                </Link>
              ),
            })}
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{children}</main>
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
