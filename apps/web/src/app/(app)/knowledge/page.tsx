"use client";

import Link from "@/lib/nav";
import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { BookOpen, Building2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";

interface Doc {
  id: string;
  name: string;
  size: number;
  status: string;
  chunkCount: number;
  error: string | null;
  /** knowledge for one client: only work for that client finds it */
  clientId: string | null;
  clientName: string | null;
  clientCode: string | null;
  createdAt: string;
}

const sel = "h-9 rounded-md border bg-background px-2 text-sm";

export default function KnowledgePage() {
  const t = useTranslations("knowledge");
  const tc = useTranslations("common");
  const fmt = useFormat();
  const qc = useQueryClient();
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const { data: clients } = useClients();
  /** which client the next upload belongs to ("" = general knowledge) */
  const [uploadClient, setUploadClient] = useState("");
  /** "" = everything, "general" = shared knowledge only, else one client */
  const [filter, setFilter] = useState("");
  const { data } = useQuery({
    queryKey: ["documents", filter],
    queryFn: () => api.get<{ documents: Doc[] }>(`/api/documents${filter ? `?clientId=${encodeURIComponent(filter)}` : ""}`).then((r) => r.documents),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending") ? 2500 : false),
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const f = new FormData();
      files.forEach((x) => f.append("files", x));
      if (uploadClient) f.append("clientId", uploadClient);
      return api.form("/api/documents", f);
    },
    onSuccess: () => {
      toast.success(t("uploaded"));
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/documents/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }) });
  const reindex = useMutation({ mutationFn: (id: string) => api.post(`/api/documents/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }) });
  const clientLabel = (c: { code: string; name: string }) => (c.code ? `${c.code} · ${c.name}` : c.name);

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json" onChange={(e) => e.target.files?.length && upload.mutate(Array.from(e.target.files))} />
            <Label htmlFor={`${uid}-for`} className="sr-only">
              {t("uploadFor")}
            </Label>
            <select id={`${uid}-for`} className={sel} value={uploadClient} onChange={(e) => setUploadClient(e.target.value)}>
              <option value="">{t("general")}</option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("forClient", { client: clientLabel(c) })}
                </option>
              ))}
            </select>
            <Button onClick={() => input.current?.click()} disabled={upload.isPending} className="gap-1.5">
              <Upload className="size-4" /> {t("upload")}
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Building2 className="size-3.5 shrink-0" aria-hidden /> {t("clientScope")}
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${uid}-filter`} className="text-xs text-muted-foreground">
            {t("filter")}
          </Label>
          <select id={`${uid}-filter`} className={sel} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">{t("filterAll")}</option>
            <option value="general">{t("general")}</option>
            {clients?.map((c) => (
              <option key={c.id} value={c.id}>
                {clientLabel(c)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) upload.mutate(Array.from(e.dataTransfer.files));
        }}
      >
        {!data?.length ? (
          <EmptyState icon={<BookOpen className="size-8" />} title={filter ? t("empty.filtered") : t("empty.title")} description={t("empty.description")} />
        ) : (
          <Card>
            <CardContent className="divide-y p-0">
              {data.map((d) => (
                <div key={d.id} className="flex items-center gap-3 p-3 text-sm">
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{d.name}</span>
                      {d.clientId ? (
                        <Link href={`/clients/${d.clientId}`} className="shrink-0 rounded-md border px-1.5 text-[11px] font-semibold leading-5 hover:bg-accent" title={t("clientOnly", { client: d.clientName ?? "" })}>
                          {d.clientCode || d.clientName}
                        </Link>
                      ) : (
                        <span className="shrink-0 rounded-md bg-secondary px-1.5 text-[11px] leading-5 text-muted-foreground">{t("general")}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("meta", { size: fmt.number(d.size / 1024, 0), count: d.chunkCount, when: fmt.ago(d.createdAt) })}
                      {d.error && <span className="text-destructive"> · {d.error}</span>}
                    </div>
                  </div>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", d.status === "indexed" ? "bg-success/15 text-success" : d.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning")}>{t.has(`status.${d.status}`) ? t(`status.${d.status}`) : d.status}</span>
                  <Button size="icon" variant="ghost" onClick={() => reindex.mutate(d.id)} aria-label={t("reindex")}>
                    <RefreshCw className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => confirm(t("confirmDelete", { name: d.name })) && del.mutate(d.id)} aria-label={tc("delete")}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
