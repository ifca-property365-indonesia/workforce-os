"use client";

import Link from "@/lib/nav";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Avatar } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import type { Approval } from "./types";

/** Pending approvals across the workspace (decisions invalidate the "approvals" key, so the list follows). */
export function usePendingApprovals() {
  return useQuery({
    queryKey: ["approvals", "pending-list"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/api/approvals?status=PENDING").then((r) => r.approvals),
    refetchInterval: 60_000,
  });
}

/** What is waiting for a decision, newest first: who asks, what for, and how long it has waited. */
export function PendingApprovalsList({ approvals, limit = 6, empty }: { approvals: Approval[] | undefined; limit?: number; empty: string }) {
  const fmt = useFormat();
  if (approvals && !approvals.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1">
      {approvals?.slice(0, limit).map((a) => (
        <li key={a.id}>
          <Link href={`/approvals?focus=${a.id}`} className="flex items-start gap-2.5 rounded-xl p-2 hover:bg-secondary/70">
            <Avatar id={a.employee?.id} mood="approval" size="sm" className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-sm font-medium leading-snug">{a.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {a.employee?.name ?? ""} · {fmt.ago(a.createdAt)}
              </span>
            </span>
            <ShieldAlert className="mt-1 size-3.5 shrink-0 text-approval" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
