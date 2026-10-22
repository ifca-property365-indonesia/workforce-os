"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Brain } from "lucide-react";
import { api } from "@/lib/api";

interface UsedMemory {
  id: string;
  kind: string;
  content: string;
  untrusted: boolean;
}

/**
 * Under a reply: how many memories the employee had in front of it (after OpenHuman's cited memory). Opening it lists
 * them; a memory deleted since is simply left out.
 */
export function MemoryChip({ ids }: { ids: string[] }) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["memories", "by-id", ids.join(",")],
    queryFn: () => api.get<{ memories: UsedMemory[] }>(`/api/memories?ids=${ids.join(",")}`),
    enabled: open,
    staleTime: 60_000,
  });
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium text-muted-foreground hover:bg-accent">
        <Brain className="size-3.5" aria-hidden /> {t("memoryChip", { count: ids.length })}
      </button>
      {open && (
        <ul className="mt-1.5 w-[min(36rem,100%)] space-y-1 rounded-lg border p-2">
          {data?.memories.map((m) => (
            <li key={m.id} className="flex gap-2">
              <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] uppercase">{m.kind}</span>
              <span className="min-w-0 break-words">{m.content}</span>
            </li>
          ))}
          {data && !data.memories.length && <li className="text-muted-foreground">{t("memoryChipGone")}</li>}
        </ul>
      )}
    </div>
  );
}
