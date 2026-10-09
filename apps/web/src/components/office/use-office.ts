"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { activityOf, layoutOffice, type Activity, type OfficeLayout, type OfficeLook } from "@wfos/shared/office";
import { api } from "@/lib/api";
import { useRealtime } from "@/lib/events";

export interface OfficePerson {
  id: string;
  name: string;
  avatar: string;
  /** office character; null derives one from the id */
  look: OfficeLook | null;
  role: string;
  department: string | null;
  status: string;
  teams: { id: string; name: string }[];
  task: { id: string; title: string; status: string } | null;
  lastStep: { kind: string; name: string; at: string } | null;
}
interface Snapshot {
  workspace: { name: string };
  departments: Record<string, string>;
  employees: OfficePerson[];
}

export interface OfficeState {
  layout: OfficeLayout;
  /** live people, read by the render loop every frame (no React re-render per event) */
  people: React.RefObject<Map<string, OfficePerson>>;
  /** bumps when the set of people or their activities change: for the text alternative */
  version: number;
  activityOf: (p: OfficePerson, now?: number) => Activity;
  roomLabel: (key: string) => string;
  /** the company name on the reception sign */
  workspaceName: string;
  loading: boolean;
}

const ACTIVE = new Set(["RUNNING", "AWAITING_APPROVAL"]);
const activity = (p: OfficePerson, now = Date.now()) => activityOf({ employeeStatus: p.status, task: p.task, lastStep: p.lastStep, now });

/** Office snapshot from /api/office, patched live from SSE; refetched (debounced) when something structural changes. */
export function useOffice(generalLabel: string): OfficeState {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["office"], queryFn: () => api.get<Snapshot>("/api/office") });
  const people = useRef(new Map<string, OfficePerson>());
  const [version, setVersion] = useState(0);
  const refetch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = () => {
    clearTimeout(refetch.current);
    refetch.current = setTimeout(() => void qc.invalidateQueries({ queryKey: ["office"] }), 800);
  };
  useEffect(() => () => clearTimeout(refetch.current), []);

  useEffect(() => {
    if (!data) return;
    people.current = new Map(data.employees.map((e) => [e.id, e]));
    setVersion((v) => v + 1);
  }, [data]);

  // stale steps turn into "thinking" and idle people wander: refresh the text alternative now and then
  useEffect(() => {
    const t = setInterval(() => setVersion((v) => v + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  useRealtime((ev) => {
    const map = people.current;
    switch (ev.type) {
      case "step.created": {
        const p = ev.step.employeeId ? map.get(ev.step.employeeId) : undefined;
        if (!p || !ev.step.taskId) return;
        const before = activity(p);
        p.lastStep = { kind: ev.step.kind, name: ev.step.name, at: ev.step.createdAt };
        if (!p.task || p.task.id !== ev.step.taskId) {
          p.task = { id: ev.step.taskId, title: p.task?.id === ev.step.taskId ? p.task.title : "", status: "RUNNING" };
          scheduleRefetch(); // for the title
        }
        if (activity(p) !== before) setVersion((v) => v + 1);
        return;
      }
      case "task.updated": {
        const p = ev.employeeId ? map.get(ev.employeeId) : [...map.values()].find((x) => x.task?.id === ev.taskId);
        if (!p) return;
        if (ACTIVE.has(ev.status)) p.task = { id: ev.taskId, title: ev.title ?? (p.task?.id === ev.taskId ? p.task.title : ""), status: ev.status };
        else if (p.task?.id === ev.taskId) {
          p.task = null;
          p.lastStep = null;
          scheduleRefetch(); // the employee may already have another task
        }
        setVersion((v) => v + 1);
        return;
      }
      case "employee.updated": {
        const p = map.get(ev.employeeId);
        if (p) {
          p.status = ev.status;
          setVersion((v) => v + 1);
        } else scheduleRefetch();
        return;
      }
      case "task.created":
      case "approval.created":
      case "approval.updated":
        scheduleRefetch();
        return;
    }
  });

  const layout = useMemo(() => {
    const deps = data?.departments ?? {};
    return layoutOffice(data?.employees ?? [], (k) => deps[k] ?? k);
  }, [data]);
  const roomLabel = (key: string) => layout.rooms.find((r) => r.key === key)?.label || generalLabel;
  return { layout, people, version, activityOf: activity, roomLabel, workspaceName: data?.workspace.name ?? "", loading: isLoading };
}
