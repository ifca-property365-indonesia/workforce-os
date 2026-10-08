"use client";

import { CodeDiff } from "@/components/inspector/code-view";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
import { useClients } from "@/lib/hooks";
import { useFormat } from "@/lib/use-format";
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
  const t = useTranslations("approvals");
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="space-y-0.5 border-b bg-muted/40 px-4 py-2 text-sm">
        <div>
          <span className="text-muted-foreground">{t("email.to")}</span> {p.to.join(", ")}
        </div>
        {!!p.cc?.length && (
          <div>
            <span className="text-muted-foreground">{t("email.cc")}</span> {p.cc.join(", ")}
          </div>
        )}
        <div>
          <span className="text-muted-foreground">{t("email.subject")}</span> <span className="font-medium">{p.subject}</span>
        </div>
      </div>
      <div className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">{p.body}</div>
    </div>
  );
}

function EmailEditor({ value, onChange }: { value: Email; onChange: (v: Email) => void }) {
  const t = useTranslations("approvals");
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">{t("editor.to")}</Label>
        <Input value={value.to.join(", ")} onChange={(e) => onChange({ ...value, to: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editor.cc")}</Label>
        <Input value={(value.cc ?? []).join(", ")} onChange={(e) => onChange({ ...value, cc: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editor.subject")}</Label>
        <Input value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("editor.body")}</Label>
        <Textarea rows={10} value={value.body} onChange={(e) => onChange({ ...value, body: e.target.value })} />
      </div>
    </div>
  );
}

function PayloadPreview({ a, editing, draft, setDraft }: { a: Approval; editing: boolean; draft: Record<string, unknown>; setDraft: (v: Record<string, unknown>) => void }) {
  const t = useTranslations("approvals");
  const f = useFormat();
  const { data: clients } = useClients();
  const p = (editing ? draft : (a.editedPayload ?? a.payload)) as Record<string, unknown>;
  if (a.toolName === "send_email") {
    return editing ? <EmailEditor value={p as unknown as Email} onChange={(v) => setDraft(v as unknown as Record<string, unknown>)} /> : <EmailPreview p={p as unknown as Email} />;
  }
  if (a.toolName === "send_invoice") {
    const inv = p as unknown as InvoicePayload;
    const client = clients?.find((c) => c.id === inv.clientId);
    const to = inv.to?.length ? inv.to : client?.email ? [client.email] : [];
    const total = f.money(invoiceTotal(inv), inv.currency);
    const subject = inv.subject || t("invoice.subject", { number: inv.invoiceNumber });
    return (
      <div className="space-y-3">
        {editing ? (
          <EmailEditor
            value={{ to, subject, body: inv.body || "" }}
            onChange={(v) => setDraft({ ...inv, to: v.to, subject: v.subject, body: v.body })}
          />
        ) : (
          <EmailPreview p={{ to, subject, body: inv.body || t("invoice.defaultBody", { number: inv.invoiceNumber, total }) }} />
        )}
        <div className="text-xs text-muted-foreground">
          {t("invoice.attachment", { file: `${inv.invoiceNumber}.pdf`, lines: inv.lines.length, total, due: inv.dueDate ? f.date(inv.dueDate) : "—" })}
        </div>
        <iframe title={t("invoice.pdfTitle")} src={`/api/approvals/${a.id}/invoice`} className="h-[480px] w-full rounded-lg border bg-white" />
      </div>
    );
  }
  if (a.toolName === "bash") {
    const b = p as { command: string; category?: string; reasons?: string[]; hooksDisabled?: boolean };
    return editing ? (
      <Textarea rows={4} className="font-mono text-xs" value={String(b.command ?? "")} onChange={(e) => setDraft({ ...p, command: e.target.value })} />
    ) : (
      <div className="space-y-2 text-sm">
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">$ {b.command}</pre>
        {!!b.reasons?.length && (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {b.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="text-xs text-muted-foreground">{t("bash.runsWhere")}</div>
      </div>
    );
  }
  if (a.toolName === "git_push") {
    const g = p as { repository: string; branch: string; head: string; commits: { sha: string; subject: string }[]; diff: string; diffTruncated?: boolean; summary?: string };
    return (
      <div className="space-y-2 text-sm">
        <div>{t("git.pushTo", { branch: g.branch, repository: g.repository, head: g.head.slice(0, 8) })}</div>
        {g.summary && <p className="text-muted-foreground">{g.summary}</p>}
        <ul className="text-xs">
          {g.commits.map((c) => (
            <li key={c.sha}>
              <code className="text-muted-foreground">{c.sha.slice(0, 8)}</code> {c.subject}
            </li>
          ))}
        </ul>
        <div className="text-xs text-muted-foreground">{t("git.hooksDisabled")}</div>
        <CodeDiff diff={g.diff} truncated={g.diffTruncated} />
      </div>
    );
  }
  if (a.toolName === "post_webhook") {
    return editing ? (
      <Textarea rows={6} value={String(p.text ?? "")} onChange={(e) => setDraft({ ...p, text: e.target.value })} />
    ) : (
      <div className="rounded-lg border bg-background p-3 text-sm">
        <div className="mb-1 text-xs text-muted-foreground">{t("webhook.channel", { channel: p.channel ? String(p.channel) : t("webhook.defaultChannel") })}</div>
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
  const t = useTranslations("approvals");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>(a.payload);
  const decide = useMutation({
    mutationFn: (body: { decision: "approve" | "edit_approve" | "reject"; editedPayload?: Record<string, unknown>; feedback?: string }) => api.post(`/api/approvals/${a.id}/decide`, body),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "reject" ? t("card.rejected") : t("card.approved"));
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pending = a.status === "PENDING";
  const simulated = a.task?.dryRun || a.task?.source === "demo";
  const toolLabel = t.has(`tools.${a.toolName}`) ? t(`tools.${a.toolName}`) : a.toolName;
  const who = a.employee ? `${a.employee.name} (${a.employee.role})` : tc("unknown");
  return (
    <Card id={a.id} className={cn(focused && "ring-2 ring-primary")}>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <Avatar emoji={a.employee?.avatar} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{a.title}</div>
          <div className="text-xs text-muted-foreground">
            {t.rich("card.wantsToRun", { employee: who, tool: toolLabel, code: (c) => <span className="font-medium text-foreground">{c}</span> })} · {f.ago(a.createdAt)}
            {a.task && (
              <>
                {" "}
                · {t("card.task")}{" "}
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
                  : a.status === "EXECUTING"
                    ? "bg-sky-500/15 text-sky-700"
                    : "bg-emerald-500/15 text-emerald-700",
          )}
        >
          {ts(`approval.${a.status}`)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {simulated && (
          <div className="flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300">
            <FlaskConical className="size-3.5" /> {t("card.dryRunNotice")}
          </div>
        )}
        {!!a.guardFindings?.length && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <div className="flex items-center gap-1 font-medium">
              <ShieldAlert className="size-3.5" /> {t("card.guardFindings")}
            </div>
            {a.guardFindings.map((g, i) => (
              <div key={i}>
                {g.severity.toUpperCase()} · {g.rule} · {g.excerpt}
              </div>
            ))}
          </div>
        )}
        <PayloadPreview a={a} editing={editing} draft={draft} setDraft={setDraft} />
        {a.editedPayload && !pending && <p className="text-xs text-muted-foreground">{t("card.editedByHuman")}</p>}
        {a.feedback && <p className="text-xs text-muted-foreground">{t("card.feedback", { feedback: a.feedback })}</p>}
        {a.executionResult?.summary && <p className="text-xs text-muted-foreground">{t("card.result", { summary: a.executionResult.summary })}</p>}
        {pending && (
          <div className="space-y-2 border-t pt-3">
            {rejecting ? (
              <div className="space-y-2">
                <Textarea placeholder={t("card.rejectPlaceholder")} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={() => decide.mutate({ decision: "reject", feedback })} disabled={decide.isPending}>
                    {t("card.rejectWithFeedback")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                    {tc("cancel")}
                  </Button>
                </div>
              </div>
            ) : editing ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decide.mutate({ decision: "edit_approve", editedPayload: draft })} disabled={decide.isPending} className="gap-1">
                  <Check className="size-3.5" /> {t("card.saveAndApprove")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => (setEditing(false), setDraft(a.payload))}>
                  {tc("cancel")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => decide.mutate({ decision: "approve" })} disabled={decide.isPending} className="gap-1">
                  <ShieldCheck className="size-3.5" /> {t("card.approve")}
                </Button>
                {a.toolName !== "git_push" && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="gap-1">
                    <Pencil className="size-3.5" /> {t("card.editAndApprove")}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)} className="gap-1 text-destructive">
                  <X className="size-3.5" /> {t("card.reject")}
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
  const t = useTranslations("approvals");
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
      <PageHeader title={t("title")} description={t("description")} />
      <Tabs value={tab} onValueChange={setTab} className="mb-4">
        <TabsList>
          <TabsTrigger value="PENDING">{t("tabs.pending")}</TabsTrigger>
          <TabsTrigger value="EXECUTED,EXECUTING,APPROVED">{t("tabs.approved")}</TabsTrigger>
          <TabsTrigger value="REJECTED,EXPIRED">{t("tabs.rejected")}</TabsTrigger>
          <TabsTrigger value="ALL">{t("tabs.all")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {!data?.length && <EmptyState icon={<ShieldCheck className="size-8" />} title={tab === "PENDING" ? t("empty.pendingTitle") : t("empty.title")} description={t("empty.description")} />}
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
