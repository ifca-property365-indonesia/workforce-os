"use client";

import Link from "@/lib/nav";
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Code2, Crown, MoreHorizontal, Pencil, Send, Trash2, UserMinus, UserPlus } from "lucide-react";
import type { TeamMemberRole } from "@wfos/shared";
import { Avatar } from "@/components/layout/common";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ExportButton } from "@/components/packages/export-dialog";
import type { BotMood } from "@/components/ui/bot-avatar";
import { api, ApiError } from "@/lib/api";
import type { Employee, Team } from "@/lib/hooks";
import { divisionSignVars } from "@/lib/sign";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

type Member = { employeeId: string; role: TeamMemberRole };
/** a structure change: the whole member list plus head and code lead, validated by the server as one */
export type Structure = { members: Member[]; leadId: string | null; codeLeadId: string | null };

const structureOf = (d: Team): Structure => ({ members: d.members.map((m) => ({ employeeId: m.employeeId, role: m.role })), leadId: d.leadId, codeLeadId: d.codeLeadId });

/** The server's refusal, kept on the card until the next change (a 409 for someone in another division can be retried as a move). */
interface StructureError {
  message: string;
  /** the same change with move: true */
  retry?: Structure;
}

/**
 * Structure changes of one division: add, remove, re-role, head, code lead. Every change sends the whole structure,
 * so the server checks it as one (head and code lead are members, subagents need a code lead, one division each).
 */
export function useDivisionStructure(d: Team) {
  const t = useTranslations("teams");
  const qc = useQueryClient();
  const [error, setError] = useState<StructureError | null>(null);
  const m = useMutation({
    mutationFn: ({ next, move }: { next: Structure; move?: boolean }) => api.patch(`/api/teams/${d.id}`, { ...next, ...(move ? { move: true } : {}) }),
    onSuccess: () => {
      setError(null);
      toast.success(t("saved"));
      void qc.invalidateQueries({ queryKey: ["teams"] });
      void qc.invalidateQueries({ queryKey: ["employees"] });
      void qc.invalidateQueries({ queryKey: ["office"] });
    },
    onError: (e, { next }) => {
      const code = e instanceof ApiError ? (e.data as { code?: string } | undefined)?.code : undefined;
      setError({ message: (e as Error).message, retry: code === "employee_in_other_division" ? next : undefined });
    },
  });
  const cur = structureOf(d);
  const apply = (next: Structure) => m.mutate({ next });
  return {
    error,
    dismiss: () => setError(null),
    pending: m.isPending,
    move: (next: Structure) => m.mutate({ next, move: true }),
    add: (employeeId: string, role: TeamMemberRole = "member") => apply({ ...cur, members: [...cur.members.filter((x) => x.employeeId !== employeeId), { employeeId, role }] }),
    remove: (employeeId: string) =>
      apply({
        members: cur.members.filter((x) => x.employeeId !== employeeId),
        leadId: cur.leadId === employeeId ? null : cur.leadId,
        codeLeadId: cur.codeLeadId === employeeId ? null : cur.codeLeadId,
      }),
    setRole: (employeeId: string, role: TeamMemberRole) => apply({ ...cur, members: cur.members.map((x) => (x.employeeId === employeeId ? { ...x, role } : x)) }),
    makeHead: (employeeId: string) => apply({ ...cur, leadId: employeeId }),
    makeCodeLead: (employeeId: string | null) => apply({ ...cur, codeLeadId: employeeId }),
  };
}

type Ops = ReturnType<typeof useDivisionStructure>;

function RoleChip({ children, tone }: { children: ReactNode; tone?: "sign" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[10.5px] font-bold uppercase leading-4 tracking-wide",
        tone === "sign" ? "bg-[var(--sign)] text-[var(--sign-ink)]" : "bg-secondary text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** One person in the org chart: avatar (live mood), name, role and specialty, 7-day credits, and the admin's menu. */
function PersonRow({
  e,
  role,
  credits,
  mood,
  admin,
  d,
  ops,
  nested,
}: {
  e: Employee;
  role: "head" | "code_lead" | TeamMemberRole;
  credits: number;
  mood?: BotMood;
  admin: boolean;
  d: Team;
  ops: Ops;
  nested?: boolean;
}) {
  const t = useTranslations("teams");
  const f = useFormat();
  const special = role === "head" || role === "code_lead";
  return (
    <li className={cn("group flex items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-secondary/60", nested && "py-1")}>
      <Avatar id={e.id} size={special ? "md" : "sm"} mood={mood} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={`/employees/${e.id}`} className={cn("truncate font-semibold hover:underline", special ? "text-[15px]" : "text-sm")}>
            {e.name}
          </Link>
          {role === "head" && (
            <RoleChip tone="sign">
              <Crown className="size-3" aria-hidden /> {t("roles.head")}
            </RoleChip>
          )}
          {role === "code_lead" && (
            <RoleChip tone="sign">
              <Code2 className="size-3" aria-hidden /> {t("roles.code_lead")}
            </RoleChip>
          )}
          {role === "subagent" && <RoleChip>{t("roles.subagent")}</RoleChip>}
          {e.status !== "ACTIVE" && <span className="text-[11px] text-warning">{t("paused")}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {e.role}
          {e.specialty ? ` · ${e.specialty}` : ""}
        </div>
      </div>
      <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground" title={t("stats.credits")}>
        {t("creditsShort", { credits: f.credits(credits) })}
      </span>
      {admin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={t("actions.menu", { name: e.name })} disabled={ops.pending}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {role !== "head" && role !== "subagent" && <DropdownMenuItem onSelect={() => ops.makeHead(e.id)}>{t("actions.makeHead")}</DropdownMenuItem>}
            {role === "member" && <DropdownMenuItem onSelect={() => ops.makeCodeLead(e.id)}>{t("actions.makeCodeLead")}</DropdownMenuItem>}
            {role === "code_lead" && <DropdownMenuItem onSelect={() => ops.makeCodeLead(null)}>{t("actions.clearCodeLead")}</DropdownMenuItem>}
            {role === "member" && d.codeLeadId && <DropdownMenuItem onSelect={() => ops.setRole(e.id, "subagent")}>{t("actions.toSubagent")}</DropdownMenuItem>}
            {role === "subagent" && <DropdownMenuItem onSelect={() => ops.setRole(e.id, "member")}>{t("actions.toMember")}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => ops.remove(e.id)}>
              <UserMinus className="size-4" /> {t("actions.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** Add someone: people outside any division first, then (as a move) people in another one. */
function AddMember({ d, employees, ops }: { d: Team; employees: Employee[]; ops: Ops }) {
  const t = useTranslations("teams");
  const [role, setRole] = useState<TeamMemberRole>("member");
  const inHere = new Set(d.members.map((m) => m.employeeId));
  const free = employees.filter((e) => !inHere.has(e.id) && !e.division);
  const elsewhere = employees.filter((e) => !inHere.has(e.id) && e.division && e.division.id !== d.id);
  if (!free.length && !elsewhere.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed pt-3">
      <UserPlus className="size-4 text-muted-foreground" aria-hidden />
      <select
        aria-label={t("actions.addMember")}
        className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm"
        value=""
        disabled={ops.pending}
        onChange={(ev) => ev.target.value && ops.add(ev.target.value, role)}
      >
        <option value="">{t("actions.addPlaceholder")}</option>
        {free.length > 0 && (
          <optgroup label={t("unassigned.title")}>
            {free.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.role}
              </option>
            ))}
          </optgroup>
        )}
        {elsewhere.length > 0 && (
          <optgroup label={t("actions.otherDivisions")}>
            {elsewhere.map((e) => (
              <option key={e.id} value={e.id}>
                {t("actions.inOther", { name: e.name, division: e.division!.name })}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <select aria-label={t("actions.addAs")} className="h-8 rounded-lg border bg-background px-2 text-sm" value={role} onChange={(ev) => setRole(ev.target.value as TeamMemberRole)}>
        <option value="member">{t("actions.asMember")}</option>
        <option value="subagent" disabled={!d.codeLeadId}>
          {t("actions.asSubagent")}
        </option>
      </select>
    </div>
  );
}

/**
 * One division on the org chart: its lit name sign (lit while it has work running), workload and 7-day credits,
 * then the head, the code lead with the subagents working inside their sandbox, and the other members.
 */
export function DivisionCard({
  d,
  byId,
  employees,
  moods,
  admin,
  onBrief,
  onEdit,
  onDelete,
}: {
  d: Team;
  byId: Map<string, Employee>;
  employees: Employee[];
  moods: Map<string, BotMood>;
  admin: boolean;
  onBrief: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("teams");
  const f = useFormat();
  const ops = useDivisionStructure(d);
  const [over, setOver] = useState(false);
  const credits = new Map(d.members.map((m) => [m.employeeId, m.credits7d]));
  const roleOf = new Map(d.members.map((m) => [m.employeeId, m.role]));
  const head = d.leadId ? byId.get(d.leadId) : undefined;
  const codeLead = d.codeLeadId ? byId.get(d.codeLeadId) : undefined;
  const subagents = d.members.filter((m) => m.role === "subagent" && m.employeeId !== d.leadId && m.employeeId !== d.codeLeadId).map((m) => byId.get(m.employeeId)).filter((e): e is Employee => !!e);
  const others = d.members
    .filter((m) => m.role === "member" && m.employeeId !== d.leadId && m.employeeId !== d.codeLeadId)
    .map((m) => byId.get(m.employeeId))
    .filter((e): e is Employee => !!e)
    .sort((a, b) => a.name.localeCompare(b.name));
  const busy = d.workload.running > 0;
  const row = (e: Employee, role: "head" | "code_lead" | TeamMemberRole, nested?: boolean) => (
    <PersonRow key={e.id} e={e} role={role} credits={credits.get(e.id) ?? 0} mood={moods.get(e.id)} admin={admin} d={d} ops={ops} nested={nested} />
  );

  return (
    <article
      style={divisionSignVars(d.color, d.id)}
      aria-label={d.name}
      onDragOver={(ev) => {
        if (!admin) return;
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev) => {
        ev.preventDefault();
        setOver(false);
        const id = ev.dataTransfer.getData("text/employee");
        if (admin && id && !roleOf.has(id)) ops.add(id);
      }}
      className={cn("flex min-w-0 flex-col rounded-2xl border bg-card transition-shadow", over && "ring-2 ring-[var(--sign)]")}
    >
      {/* the division's own sign: lit while it has work running */}
      {/* .sign sets its own default colour: the division's colour has to sit on the sign itself */}
      <header className="sign m-3 mb-0 flex min-h-24 flex-col justify-between rounded-[10px] p-3.5" style={divisionSignVars(d.color, d.id)} data-state={busy ? "lit" : "off"}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-display min-w-0 truncate text-[1.85rem]">{d.name}</h2>
          {d.key && <span className="shrink-0 rounded-md bg-black/20 px-1.5 font-mono text-[10.5px] font-bold leading-4">{d.key}</span>}
        </div>
        <div className="flex items-end justify-between gap-2 text-xs font-semibold leading-tight">
          <span className="truncate opacity-90">{t("headcount", { count: d.members.length })}</span>
          <span className="shrink-0">{busy || d.workload.queued ? t("sign.busy", { running: d.workload.running, queued: d.workload.queued }) : t("sign.idle")}</span>
        </div>
      </header>

      <dl className="mx-3 mt-5 grid grid-cols-3 divide-x rounded-xl border text-center">
        {[
          [t("stats.running"), d.workload.running],
          [t("stats.queued"), d.workload.queued],
          [t("stats.credits"), f.credits(d.credits7d)],
        ].map(([label, value]) => (
          <div key={String(label)} className="px-2 py-2">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="font-display text-[1.5rem] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {d.description && <p className="mx-4 mt-3 line-clamp-3 text-xs text-muted-foreground">{d.description}</p>}

      <div className="flex flex-1 flex-col gap-3 p-3">
        {ops.error && (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
            <p>{ops.error.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {ops.error.retry && (
                <Button size="xs" variant="outline" onClick={() => ops.move(ops.error!.retry!)} disabled={ops.pending}>
                  {t("actions.move")}
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={ops.dismiss}>
                {t("actions.dismiss")}
              </Button>
            </div>
          </div>
        )}

        <ul className="space-y-0.5">
          {head ? row(head, "head") : <li className="rounded-xl border border-dashed px-3 py-2 text-xs text-warning">{t("noHead")}</li>}
        </ul>

        {(codeLead || subagents.length > 0) && (
          <div>
            <ul className="space-y-0.5">{codeLead && row(codeLead, "code_lead")}</ul>
            {subagents.length > 0 && (
              <div className="ml-6 border-l-2 border-[color-mix(in_srgb,var(--sign)_55%,transparent)] pl-3">
                <p className="pt-1 text-[11px] font-medium text-muted-foreground">{t("sandbox")}</p>
                <ul className="space-y-0.5">{subagents.map((e) => row(e, "subagent", true))}</ul>
              </div>
            )}
          </div>
        )}

        <div>
          <p className="px-2 text-[11px] font-semibold text-muted-foreground">{t("members")}</p>
          {others.length ? <ul className="space-y-0.5">{others.map((e) => row(e, "member"))}</ul> : <p className="px-2 py-1 text-xs text-muted-foreground">{t("noMembers")}</p>}
        </div>

        {admin && <AddMember d={d} employees={employees} ops={ops} />}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2.5">
        <Button size="sm" variant="secondary" disabled={!d.leadId} onClick={onBrief} className="gap-1.5">
          <Send className="size-3.5" /> {t("actions.brief")}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">{t("parallel", { count: d.maxParallel })}</span>
        {admin && (
          <>
            <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={t("actions.edit", { name: d.name })}>
              <Pencil className="size-4" />
            </Button>
            <ExportButton selection={{ teamIds: [d.id] }} name={d.name} variant="ghost" />
            <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label={t("actions.delete", { name: d.name })}>
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}
