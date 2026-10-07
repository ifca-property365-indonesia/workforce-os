"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeEvent } from "@wfos/shared";

type Listener = (ev: RealtimeEvent) => void;
const Ctx = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean } | null>(null);

/** One EventSource per tab; invalidates TanStack queries and fans events out to listeners. */
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
    const connect = () => {
      es = new EventSource("/api/events");
      es.addEventListener("ready", () => setConnected(true));
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
            break;
          case "step.created":
            invalidate("steps");
            invalidate("dashboard");
            break;
          case "approval.created":
          case "approval.updated":
            invalidate("approvals");
            invalidate("task");
            invalidate("notifications");
            break;
          case "employee.updated":
            invalidate("employees");
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
