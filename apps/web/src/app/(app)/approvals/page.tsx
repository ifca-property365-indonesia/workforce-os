"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FlaskConical, Pencil, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { invoiceTotal, type InvoicePayload } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, EmptyState, PageHeader } from "@/components/layout/common";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { useClients } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface Approval {
  id: string;
  toolName: string;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  status: string;
  feedback: string | null;
  executionResult: { summary?: string } | null;
  guardFindings: { rule: string; severity: string; excerpt: string }[];
  createdAt: string;
  decidedAt: string | null;
  employee: { id: string; name: string; avatar: string; role: string } | null;
  task: { id: string; title: string; dryRun: boolean; source: string } | null;
}

interface Email {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

function EmailPreview({ p }: { p: Email }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="space-y-0.5 border-b bg-muted/40 px-4 py-2 text-sm">
        <div>
          <span className="text-muted-foreground">To:</span> {p.to.join(", ")}
        </div>
        {!!p.cc?.length && (
          <div>
            <span className="text-muted-foreground">Cc:</span> {p.cc.join(", ")}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">Subject:</span> <span className="font-medium">{p.subject}</span>
        </div>
      </div>
      <div className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">{p.body}</div>
    </div>
  );
}

function EmailEditor({ value, onChange }: { value: Email; onChange: (v: Email) => void }) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">To (comma separated)</Label>
        <Input value={value.to.join(", ")} onChange={(e) => onChange({ ...value, to: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Cc</Label>
        <Input value={(value.cc ?? []).join(", ")} onChange={(e) => onChange({ ...value, cc: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Subject</Label>
        <Input value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Body</Label>
        <Textarea rows={10} value={value.body} onChange={(e) => onChange({ ...value, body: e.target.value })} />
      </div>
    </div>
  );
}

function PayloadPreview({ a, editing, draft, setDraft }: { a: Approval; editing: boolean; draft: Record<string, unknown>; setDraft: (v: Record<string, unknown>) => void }) {
  const { data: clients } = useClients();
  const p = (editing ? draft : (a.editedPayload ?? a.payload)) as Record<string, unknown>;
  if (a.toolName === "send_email") {
    return editing ? <EmailEditor value={p as unknown as Email} onChange={(v) => setDraft(v as unknown as Record<string, unknown>)} /> : <EmailPreview p={p as unknown as Email} />;
  }
  if (a.toolName === "send_invoice") {
    const inv = p as unknown as InvoicePayload;
    const client = clients?.find((c) => c.id === inv.clientId);
    const to = inv.to?.length ? inv.to : client?.email ? [client.email] : [];
    return (
      <div className="space-y-3">
        {editing ? (
          <EmailEditor
            value={{ to, subject: inv.subject || `Invoice ${inv.invoiceNumber}`, body: inv.body || "" }}
            onChange={(v) => setDraft({ ...inv, to: v.to, subject: v.subject, body: v.body })}
          />
        ) : (
          <EmailPreview p={{ to, subject: inv.subject || `Invoice ${inv.invoiceNumber}`, body: inv.body || `(default invoice email) Invoice ${inv.invoiceNumber}, total ${inv.currency} ${invoiceTotal(inv)}` }} />
        )}
        <div className="text-xs text-muted-foreground">
          Attachment: {inv.invoiceNumber}.pdf — {inv.lines.length} line(s), total {inv.currency} {invoiceTotal(inv).toLocaleString()} · due {inv.dueDate}
        </div>
        <iframe title="Invoice PDF" src={`/api/approvals/${a.id}/invoice`} className="h-[480px] w-full rounded-lg border bg-white" />
      </div>
    );
  }
  if (a.toolName === "post_webhook") {
    return editing ? (
      <Textarea rows={6} value={String(p.text ?? "")} onChange={(e) => setDraft({ ...p, text: e.target.value })} />
    ) : (
      <div className="rounded-lg border bg-background p-3 text-sm">
        <div className="mb-1 text-xs text-muted-foreground">Channel: {String(p.channel ?? "default")}</div>
        <div className="whitespace-pre-wrap">{String(p.text)}</div>
      </div>
    );
  }
  return editing ? (
    <Textarea
      rows={10}
      className="font-mono text-xs"
      defaultValue={JSON.stringify(p, null, 2)}
      onChange={(e) => {
        try {
          setDraft(JSON.parse(e.target.value));
        } catch {
          /* keep last valid */
        }
      }}
    />
  ) : (
    <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{JSON.stringify(p, null, 2)}</pre>
  );
}

function ApprovalCard({ a, focused }: { a: Approval; focused: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>(a.payload);
  const decide = useMutation({
    mutationFn: (body: { decision: "approve" | "edit_approve" | "reject"; editedPayload?: Record<string, unknown>; feedback?: string }) => api.post(`/api/approvals/${a.id}/decide`, body),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "reject" ? "Rejected — feedback saved to the employee's memory" : "Approved — executing now");
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pending = a.status === "PENDING";
  const simulated = a.task?.dryRun || a.task?.source === "demo";
  return (
    <Card id={a.id} className={cn(focused && "ring-2 ring-primary")}>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <Avatar emoji={a.employee?.avatar} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{a.title}</div>
          <div className="text-xs text-muted-foreground">
            {a.employee?.name} ({a.employee?.role}) wants to run <code>{a.toolName}</code> · {ago(a.createdAt)}
            {a.task && (
              <>
                {" "}
                · task{" "}
                <Link href={`/tasks/${a.task.id}`} className="text-primary hover:underline">
                  {a.task.title}
                </Link>
              </>
            )}
          </div>
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{a.reason}</div>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            pending
              ? "bg-amber-500/15 text-amber-700"
              : a.status === "REJECTED" || a.status === "FAILED"
                ? "bg-destructive/15 text-destructive"
                : a.status === "EXPIRED"
                  ? "bg-muted text-muted-foreground"
                  : "bg-emerald-500/15 text-emerald-700",
          )}
        >
          {a.status}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {simulated && (
          <div className="flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
            <FlaskConical className="size-3.5" /> Dry run: approving records what would happen; nothing is actually sent.
          </div>
        )}
        {!!a.guardFindings?.length && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <div className="flex items-center gap-1 font-medium">
              <ShieldAlert className="size-3.5" /> Guard findings
            </div>
            {a.guardFindings.map((g, i) => (
              <div key={i}>
                {g.severity.toUpperCase()} · {g.rule} · {g.excerpt}
              </div>
            ))}
          </div>
        )}
        <PayloadPreview a={a} editing={editing} draft={draft} setDraft={setDraft} />
        {a.editedPayload && !pending && <p className="text-xs text-muted-foreground">Edited by a human before approval.</p>}
        {a.feedback && <p className="text-xs text-muted-foreground">Feedback: {a.feedback}</p>}
        {a.executionResult?.summary && <p className="text-xs text-muted-foreground">Result: {a.executionResult.summary}</p>}
        {pending && (
          <div className="space-y-2 border-t pt-3">
            {rejecting ? (
              <div className="space-y-2">
                <Textarea placeholder="What should change? This is written to the employee's memory." value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={() => decide.mutate({ decision: "reject", feedback })} disabled={decide.isPending}>
                    Reject with feedback
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : editing ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decide.mutate({ decision: "edit_approve", editedPayload: draft })} disabled={decide.isPending} className="gap-1">
                  <Check className="size-3.5" /> Save edits & approve
                </Button>
                <Button variant="ghost" size="sm" onClick={() => (setEditing(false), setDraft(a.payload))}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => decide.mutate({ decision: "approve" })} disabled={decide.isPending} className="gap-1">
                  <ShieldCheck className="size-3.5" /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="gap-1">
                  <Pencil className="size-3.5" /> Edit & approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)} className="gap-1 text-destructive">
                  <X className="size-3.5" /> Reject
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Inbox() {
  const sp = useSearchParams();
  const focus = sp.get("focus");
  const [tab, setTab] = useState("PENDING");
  const { data } = useQuery({
    queryKey: ["approvals", tab],
    queryFn: () => api.get<{ approvals: Approval[] }>(`/api/approvals${tab === "ALL" ? "" : `?status=${tab}`}`).then((r) => r.approvals),
  });
  useEffect(() => {
    if (focus && data) document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, data]);
  return (
    <div>
      <PageHeader title="Approvals inbox" description="Every irreversible action stops here, per action, with the exact payload that will be executed." />
      <Tabs value={tab} onValueChange={setTab} className="mb-4">
        <TabsList>
          <TabsTrigger value="PENDING">Pending</TabsTrigger>
          <TabsTrigger value="EXECUTED,EXECUTING,APPROVED">Approved</TabsTrigger>
          <TabsTrigger value="REJECTED,EXPIRED">Rejected & expired</TabsTrigger>
          <TabsTrigger value="ALL">All</TabsTrigger>
        </TabsList>
      </Tabs>
      {!data?.length && <EmptyState icon={<ShieldCheck className="size-8" />} title={tab === "PENDING" ? "Nothing waiting" : "No approvals"} description="When an employee tries to send, publish, pay or delete, it will appear here." />}
      <div className="space-y-4">
        {data?.map((a) => (
          <ApprovalCard key={a.id} a={a} focused={a.id === focus} />
        ))}
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
