"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useEmployees } from "@/lib/hooks";
import { employeeLooks, signStateOf, signVars, type SignColor, type SignState } from "@/lib/sign";
import { cn } from "@/lib/utils";
import type { IncidentRow } from "@/components/inspector/incidents-card";
import type { BotMood } from "@/components/ui/bot-avatar";
import type { Activity } from "@wfos/shared/office";
import { useOffice } from "./use-office";

/** Sign colours for every employee of the workspace (archived ones too, so colours never shift), owners' picks first. */
export function useSignColors(): Map<string, SignColor> {
  const { data } = useEmployees();
  return useMemo(() => employeeLooks(data ?? []).colors, [data]);
}

const MOOD: Record<Activity, BotMood> = { typing: "working", reading: "working", terminal: "working", thinking: "working", waiting: "approval", idle: "idle", paused: "off" };

/** What every employee's bot avatar is doing, live from the office snapshot (an open incident wins). */
export function useBotMoods(): Map<string, BotMood> {
  const t = useTranslations("office");
  const { version, people, activityOf } = useOffice(t("generalRoom"));
  const faulty = useFaulty();
  return useMemo(() => {
    void version; // the people map is a ref patched live; version says when it changed
    const now = Date.now();
    return new Map([...people.current.values()].map((p) => [p.id, faulty.has(p.id) ? "fault" : MOOD[activityOf(p, now)]]));
  }, [version, people, activityOf, faulty]);
}

const OPEN_INCIDENT = new Set(["open", "handling", "escalated"]);

/** employees with an open incident */
function useFaulty(): Set<string> {
  const { data: inc } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => api.get<{ incidents: IncidentRow[]; resolved7d: number }>("/api/incidents"),
    refetchInterval: 60_000,
  });
  return useMemo(() => new Set((inc?.incidents ?? []).filter((i) => OPEN_INCIDENT.has(i.status) && i.employee).map((i) => i.employee!.id)), [inc]);
}

const SIZE = {
  lg: { box: "h-28 min-w-[11.5rem] p-3.5", name: "text-[2.1rem]" },
  md: { box: "h-24 min-w-[10rem] p-3", name: "text-[1.85rem]" },
  sm: { box: "h-16 min-w-[8.5rem] px-2.5 py-2", name: "text-[1.35rem]" },
} as const;

/**
 * One employee as a backlit acrylic shop sign: lit while working (a short flicker-on when a run starts),
 * flickering while an incident is open, dark when idle or paused. The state is also written out as text,
 * so it never depends on the light alone (and reduced motion turns the flicker off).
 */
export function EmployeeSign({
  name,
  role,
  status,
  state,
  color,
  tag,
  href,
  size = "md",
  className,
}: {
  name: string;
  role: string;
  status: string;
  state: Exclude<SignState, "starting">;
  color: SignColor;
  tag?: string;
  href?: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  // a sign that goes from dark to lit flickers on once (the animation runs one time, then it reads as lit)
  const [last, setLast] = useState(state);
  const [startedNow, setStartedNow] = useState(false);
  if (last !== state) {
    setLast(state);
    setStartedNow(last === "off" && state === "lit");
  }
  const shown: SignState = startedNow && state === "lit" ? "starting" : state;
  const s = SIZE[size];
  const body = (
    <>
      {tag && <span className="absolute right-2 top-2 rounded-md bg-black/20 px-1.5 text-[10.5px] font-bold leading-4 tracking-wide">{tag}</span>}
      <span className={cn("font-display block truncate pr-10", s.name)}>{name}</span>
      <span className="flex items-end justify-between gap-2 text-xs font-semibold leading-tight">
        <span className="truncate opacity-90">{role}</span>
        <span className="shrink-0 truncate text-right">{status}</span>
      </span>
    </>
  );
  const cls = cn("sign flex flex-col justify-between rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", s.box, className);
  const label = `${name}, ${role}: ${status}`;
  return href ? (
    <Link href={href} className={cls} data-state={shown} style={signVars(color)} aria-label={label}>
      {body}
    </Link>
  ) : (
    <div className={cls} data-state={shown} style={signVars(color)} role="img" aria-label={label}>
      {body}
    </div>
  );
}

/**
 * The street: a row of employee signs, live from the office snapshot (SSE). `ids` limits and orders it (a team,
 * or one employee); without it the whole office shows, working employees first.
 */
export function OfficeFacade({ ids, leadId, size = "md", className }: { ids?: readonly string[]; leadId?: string | null; size?: keyof typeof SIZE; className?: string }) {
  const t = useTranslations("office");
  const office = useOffice(t("generalRoom"));
  const colors = useSignColors();
  const faulty = useFaulty();
  const { version, people, activityOf } = office;
  const signs = useMemo(() => {
    void version; // the people map is a ref patched live; version says when it changed
    const all = [...people.current.values()];
    const now = Date.now();
    const rows = (ids ? ids.map((id) => all.find((p) => p.id === id)).filter((p) => !!p) : all).map((p) => {
      const activity = activityOf(p, now);
      return { p, activity, state: signStateOf(activity, faulty.has(p.id)) };
    });
    if (!ids) rows.sort((a, b) => Number(a.state === "off") - Number(b.state === "off") || a.p.name.localeCompare(b.p.name));
    return rows;
  }, [version, people, activityOf, ids, faulty]);

  if (!signs.length) return null;
  return (
    <ul aria-label={t("facade")} className={cn("flex snap-x gap-3 overflow-x-auto pb-5 pt-1 [scrollbar-width:none]", className)}>
      {signs.map(({ p, activity, state }) => (
        <li key={p.id} className="snap-start">
          <EmployeeSign
            name={p.name}
            role={p.role}
            status={state === "fault" ? t("incident") : t(`activity.${activity}`)}
            state={state}
            color={colors.get(p.id) ?? "merah"}
            tag={p.id === leadId ? t("lead") : undefined}
            href={`/employees/${p.id}`}
            size={size}
          />
        </li>
      ))}
    </ul>
  );
}
