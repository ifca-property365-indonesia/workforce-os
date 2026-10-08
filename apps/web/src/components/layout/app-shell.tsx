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
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employees", label: "Employees", icon: Bot },
  { href: "/teams", label: "Teams", icon: UsersRound },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/tasks", label: "Task board", icon: KanbanSquare },
  { href: "/routines", label: "Routines", icon: CalendarClock },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, badge: "approvals" as const },
  { href: "/clients", label: "Clients", icon: Building2 },
  { href: "/knowledge", label: "Knowledge base", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
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
            <span className="flex-1">{n.label}</span>
            {n.badge && !!data && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{data}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function KillSwitch() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const engaged = !!me?.workspace.killSwitch;
  const m = useMutation({
    mutationFn: (v: boolean) => api.post("/api/killswitch", { engaged: v, reason }),
    onSuccess: (_d, v) => {
      toast[v ? "error" : "success"](v ? "Kill switch engaged: all employees stopped." : "Kill switch released.");
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
        <span className="hidden sm:inline">{engaged ? "Release kill switch" : "Kill switch"}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{engaged ? "Release the kill switch?" : "Stop all employees now?"}</DialogTitle>
            <DialogDescription>
              {engaged
                ? "Queued tasks will start again. Running work that was stopped stays cancelled."
                : "Every running employee in this workspace is aborted immediately. Queued work is held and approvals cannot execute until you release the switch."}
            </DialogDescription>
          </DialogHeader>
          {!engaged && <Textarea placeholder="Reason (written to the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={engaged ? "default" : "destructive"} disabled={m.isPending} onClick={() => m.mutate(!engaged)}>
              {engaged ? "Release" : "Stop everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ notifications: { id: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }[]; unread: number }>("/api/notifications"),
    refetchInterval: 60_000,
  });
  useRealtime((ev) => {
    if (ev.type === "approval.created") toast.warning(`Approval needed: ${ev.title}`, { action: { label: "Open", onClick: () => (location.href = "/approvals") } });
    if (ev.type === "task.updated" && ev.status === "FAILED") toast.error(`Task failed${ev.title ? `: ${ev.title}` : ""}`);
    if (ev.type === "demo.stage") toast.info(ev.detail);
    if (ev.type === "employee.updated" && ev.status === "PAUSED_BUDGET") toast.warning("An employee was paused: budget cap reached.");
    if (ev.type === "approval.created" || ev.type === "task.updated") void qc.invalidateQueries({ queryKey: ["notifications"] });
  });
  const markRead = useMutation({ mutationFn: () => api.post("/api/notifications"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <Popover onOpenChange={(o) => !o && data?.unread && markRead.mutate()}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="relative" aria-label="Notifications">
          <Bell className="size-4" />
          {!!data?.unread && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Notifications</div>
        <div className="max-h-96 overflow-y-auto">
          {!data?.notifications.length && <p className="p-4 text-sm text-muted-foreground">Nothing yet.</p>}
          {data?.notifications.map((n) => (
            <Link key={n.id} href={n.link ?? "#"} className={cn("block border-b px-3 py-2 text-sm hover:bg-accent", !n.readAt && "bg-primary/5")}>
              <div className="font-medium">{n.title}</div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{n.body}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{ago(n.createdAt)}</div>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThemeToggle() {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Toggle theme"
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
            {me?.user.email} · {me?.role}
          </span>
        </Link>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-zinc-400")} /> {live ? "Live" : "Connecting…"}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-sidebar lg:block">{sidebar}</aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <Button size="icon" variant="ghost" className="lg:hidden" onClick={() => setMobile(true)} aria-label="Menu">
            <Menu className="size-5" />
          </Button>
          <div className="flex-1" />
          <KillSwitch />
          <Notifications />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="rounded-full" aria-label="Account menu">
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
                  <UserRound className="size-4" /> Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings">
                  <Settings className="size-4" /> Workspace settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  await api.post("/api/auth/logout");
                  router.replace("/login");
                }}
              >
                <LogOut className="size-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        {me?.workspace.killSwitch && (
          <div className="flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-white">
            <OctagonX className="size-4" /> Kill switch engaged — all employees are stopped and no actions can execute.
          </div>
        )}
        {me?.workspace.demoMode && (
          <div className="flex flex-wrap items-center gap-2 bg-violet-600 px-4 py-1.5 text-sm text-white">
            <CheckCircle2 className="size-4" /> Demo mode: runs are scripted, cost 0 credits and make no network calls.
            <Link href="/settings" className="underline underline-offset-2">
              Turn off
            </Link>
          </div>
        )}
        {me && !me.claude.credentialPresent && !me.workspace.demoMode && (
          <div className="bg-amber-500/15 px-4 py-1.5 text-sm text-amber-800 dark:text-amber-200">
            No Claude credential for this workspace. Employees cannot run until an Owner adds one in{" "}
            <Link href="/settings" className="underline underline-offset-2">
              Settings
            </Link>{" "}
            — or turn on Demo Mode.
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
