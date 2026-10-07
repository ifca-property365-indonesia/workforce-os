"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Doc {
  id: string;
  name: string;
  size: number;
  status: string;
  chunkCount: number;
  error: string | null;
  createdAt: string;
}

export default function KnowledgePage() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["documents"],
    queryFn: () => api.get<{ documents: Doc[] }>("/api/documents").then((r) => r.documents),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending") ? 2500 : false),
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const f = new FormData();
      files.forEach((x) => f.append("files", x));
      return api.form("/api/documents", f);
    },
    onSuccess: () => {
      toast.success("Uploaded — indexing (chunk + embed) in the background");
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/documents/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }) });
  const reindex = useMutation({ mutationFn: (id: string) => api.post(`/api/documents/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }) });

  return (
    <div>
      <PageHeader
        title="Knowledge base"
        description="Workspace-wide documents. Chunked and embedded locally (pgvector); employees cite them via kb_search."
        actions={
          <>
            <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json" onChange={(e) => e.target.files?.length && upload.mutate(Array.from(e.target.files))} />
            <Button onClick={() => input.current?.click()} disabled={upload.isPending} className="gap-1.5">
              <Upload className="size-4" /> Upload PDF / DOCX / MD
            </Button>
          </>
        }
      />
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) upload.mutate(Array.from(e.dataTransfer.files));
        }}
      >
        {!data?.length ? (
          <EmptyState icon={<BookOpen className="size-8" />} title="No documents" description="Drop files here or use Upload. Handbooks, policies, price lists, FAQs…" />
        ) : (
          <Card>
            <CardContent className="divide-y p-0">
              {data.map((d) => (
                <div key={d.id} className="flex items-center gap-3 p-3 text-sm">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {(d.size / 1024).toFixed(0)} KB · {d.chunkCount} chunks · {ago(d.createdAt)}
                      {d.error && <span className="text-destructive"> · {d.error}</span>}
                    </div>
                  </div>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", d.status === "indexed" ? "bg-emerald-500/15 text-emerald-700" : d.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-700")}>{d.status}</span>
                  <Button size="icon" variant="ghost" onClick={() => reindex.mutate(d.id)} aria-label="Re-index">
                    <RefreshCw className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => confirm(`Delete ${d.name}?`) && del.mutate(d.id)} aria-label="Delete">
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
