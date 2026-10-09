"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { describeOrder, type Activity } from "@wfos/shared/office";
import { PageHeader } from "@/components/layout/common";
import { Office2D } from "@/components/office/office-2d";
import { useOffice, type OfficePerson } from "@/components/office/use-office";
import { useRealtimeStatus } from "@/lib/events";
import { cn } from "@/lib/utils";

const Office3D = dynamic(() => import("@/components/office/office-3d"), { ssr: false, loading: () => <Loading3D /> });

function Loading3D() {
  const t = useTranslations("office");
  return <p className="rounded-lg border p-6 text-sm text-muted-foreground">{t("loading3d")}</p>;
}

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

const VIEW_KEY = "wfos-office-view";
const WORKING: Activity[] = ["typing", "reading", "terminal", "thinking"];

export default function OfficePage() {
  const t = useTranslations("office");
  const router = useRouter();
  const live = useRealtimeStatus();
  const reducedMotion = useReducedMotion();
  const state = useOffice(t("generalRoom"));
  const [view, setView] = useState<"2d" | "3d">("2d");
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "3d") setView("3d");
    } catch {}
  }, []);
  const choose = (v: "2d" | "3d") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  const activityLabel = (p: OfficePerson) => t(`activity.${state.activityOf(p)}`);
  const open = (p: OfficePerson) => router.push(p.task ? `/tasks/${p.task.id}` : `/employees/${p.id}`);
  // re-read on every version bump: the people map is mutated in place by live events
  void state.version;
  const people = describeOrder([...state.people.current.values()].map((p) => ({ ...p, activity: state.activityOf(p) })));
  const count = (as: Activity[]) => people.filter((p) => as.includes(p.activity)).length;
  const summary = t("summary", { total: people.length, working: count(WORKING), waiting: count(["waiting"]), idle: count(["idle", "paused"]) });
  const viewProps = { state, reducedMotion, onSelect: open, labels: { lounge: t("lounge"), reception: t("reception"), activity: activityLabel } };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex items-center gap-3">
            <span className={cn("text-xs", live ? "text-emerald-600" : "text-muted-foreground")}>{live ? t("live") : t("offline")}</span>
            <div role="group" aria-label={t("viewLabel")} className="inline-flex rounded-md border p-0.5">
              {(["2d", "3d"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => choose(v)}
                  className={cn("rounded px-3 py-1 text-sm", view === v ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  {v === "2d" ? t("view2d") : t("view3d")}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {!state.loading && people.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div role="img" aria-label={summary} aria-describedby="office-people">
          {view === "3d" ? <Office3D {...viewProps} onUnavailable={() => choose("2d")} /> : <Office2D {...viewProps} />}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t("legend.desk")}</span>
        <span>{t("legend.bookshelf")}</span>
        <span>{t("legend.rack")}</span>
        <span>{t("legend.alert")}</span>
      </div>

      <section aria-labelledby="office-people-title" className="rounded-lg border p-4">
        <h2 id="office-people-title" className="mb-1 text-sm font-medium">
          {t("listTitle")}
        </h2>
        <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
          {summary}
        </p>
        <ul id="office-people" className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {people.map((p) => (
            <li key={p.id}>
              <Link href={p.task ? `/tasks/${p.task.id}` : `/employees/${p.id}`} className={cn("block truncate rounded px-2 py-1 hover:bg-accent", p.activity === "waiting" && "font-medium text-amber-600")}>
                <span aria-hidden="true" className="mr-1">
                  {p.avatar}
                </span>
                {p.task?.title ? t("personTask", { name: p.name, activity: t(`activity.${p.activity}`), task: p.task.title }) : t("person", { name: p.name, activity: t(`activity.${p.activity}`) })}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
