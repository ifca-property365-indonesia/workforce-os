"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeEvent } from "@wfos/shared";

type Listener = (ev: RealtimeEvent) => void;
const Ctx = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean } | null>(null);

/**
 * One EventSource per tab; invalidates TanStack queries and fans events out to listeners. After a dropped
 * connection comes back, the event-driven queries (open conversations included) are refetched.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = (key: string) => {
      pending.add(key);
      if (!flushTimer)
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          for (const k of pending) void qc.invalidateQueries({ queryKey: [k] });
          pending.clear();
        }, 250);
    };
    /** events published while the stream was down are lost: on a reconnect, refetch what they would have updated */
    const RECONNECT_KEYS = ["conversation", "conversations", "approvals", "tasks", "task", "steps", "notifications", "employees", "dashboard", "incidents", "outbox", "clients", "client", "invoices", "servers", "apps", "app", "release"];
    let wasConnected = false;
    const connect = () => {
      es = new EventSource("/api/events");
      es.addEventListener("ready", () => {
        if (wasConnected) for (const k of RECONNECT_KEYS) invalidate(k);
        wasConnected = true;
        setConnected(true);
      });
      es.onmessage = (m) => {
        let ev: RealtimeEvent;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        for (const l of listeners.current) l(ev);
        switch (ev.type) {
          case "task.created":
          case "task.updated":
            invalidate("tasks");
            invalidate("task");
            invalidate("dashboard");
            invalidate("incidents");
            invalidate("client");
            // a run that ended brings the task's held approvals into the inbox (and its count)
            invalidate("approvals");
            break;
          case "step.created":
            invalidate("steps");
            invalidate("dashboard");
            break;
          case "task.progress":
            invalidate("tasks");
            invalidate("task");
            break;
          case "approval.created":
          case "approval.updated":
            invalidate("approvals");
            invalidate("task");
            // a push or a merge decision changes a task's Code tab and its app's "not in main yet" list
            invalidate("task-code");
            invalidate("repo-unmerged");
            invalidate("notifications");
            // email proposals are listed in the outbox until the worker writes their attempt
            invalidate("outbox");
            break;
          case "outbox.updated":
            invalidate("outbox");
            // a client's History tab lists its emails
            invalidate("client");
            break;
          case "invoice.updated":
            // ["clients"] list totals, ["client", id] detail, ["invoices", …] ledgers
            invalidate("clients");
            invalidate("client");
            invalidate("invoices");
            break;
          case "employee.updated":
            invalidate("employees");
            // a budget pause (or its end) is listed under "Needs a decision"
            invalidate("approvals");
            break;
          case "app.updated":
            // ["apps"] list, ["app", id] page
            invalidate("apps");
            invalidate("app");
            break;
          case "release.updated":
            // ["app", appId] releases table, ["release", id] log viewer; the list shows the current release too;
            // ["task", id] lists the previews a task published
            invalidate("app");
            invalidate("release");
            invalidate("apps");
            invalidate("task");
            break;
          case "server.updated":
            // ["servers"] list, ["servers", "ssh-key", id] prepare command (domain/user may have changed)
            invalidate("servers");
            break;
          case "killswitch":
            invalidate("me");
            invalidate("settings");
            break;
          case "replay.updated":
            invalidate("replays");
            break;
          case "chat.message":
            invalidate("conversations");
            break;
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
      clearTimeout(flushTimer);
    };
  }, [qc]);

  return (
    <Ctx.Provider
      value={{
        subscribe: (l) => {
          listeners.current.add(l);
          return () => {
            listeners.current.delete(l);
          };
        },
        connected,
      }}
    >{children}</Ctx.Provider>
  );
}

export function useRealtime(listener: Listener) {
  const ctx = useContext(Ctx);
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((ev) => ref.current(ev));
  }, [ctx]);
}

export function useRealtimeStatus() {
  return useContext(Ctx)?.connected ?? false;
}
