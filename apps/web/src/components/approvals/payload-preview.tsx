"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import { invoiceSubtotal, invoiceTax, invoiceTotal, type InvoicePayload } from "@wfos/shared";
import { CodeDiff } from "@/components/inspector/code-view";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useClients, useEmployees, useTeams } from "@/lib/hooks";
import { SchedulePreviewView, useSchedulePreview } from "@/components/routines/schedule-preview";
import { useFormat } from "@/lib/use-format";
import { cn } from "@/lib/utils";
import { handoffPick, handoffTarget, type HandoffPayload } from "@/lib/handoff";
import { PreviewApprovalPreview } from "./preview-approval";
import { ReleaseApprovalPreview } from "./release-approval";
import type { Approval, Email } from "./types";

export function EmailPreview({ p }: { p: Email }) {
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

export function EmailEditor({ value, onChange }: { value: Email; onChange: (v: Email) => void }) {
  const t = useTranslations("approvals");
  const uid = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-to`}>{t("editor.to")}</Label>
        <Input id={`${uid}-to`} value={value.to.join(", ")} onChange={(e) => onChange({ ...value, to: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-cc`}>{t("editor.cc")}</Label>
        <Input id={`${uid}-cc`} value={(value.cc ?? []).join(", ")} onChange={(e) => onChange({ ...value, cc: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-subject`}>{t("editor.subject")}</Label>
        <Input id={`${uid}-subject`} value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-body`}>{t("editor.body")}</Label>
        <Textarea id={`${uid}-body`} rows={10} value={value.body} onChange={(e) => onChange({ ...value, body: e.target.value })} />
      </div>
    </div>
  );
}

/** The PRD handoff fields Edit & Approve may change: the division that builds it and the repository (older payloads: the developer). */
type HandoffPick = ReturnType<typeof handoffPick>;

/** Which division builds the approved PRD, and in which repository (the PRD text itself is approved as written). */
export function HandoffPicker({ value, onChange }: { value: HandoffPick; onChange: (v: HandoffPick) => void }) {
  const t = useTranslations("approvals");
  const { data: divisions } = useTeams();
  const { data: emps } = useEmployees();
  const { data: repos } = useQuery({ queryKey: ["repositories"], queryFn: () => api.get<{ repositories: { id: string; name: string }[] }>("/api/repositories").then((r) => r.repositories) });
  const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";
  const uid = useId();
  // a payload made before divisions names a developer; it can still be changed to a division
  const legacy = value.teamId === undefined && value.developerId !== undefined;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-team`}>{t("handoff.division")}</Label>
        <select id={`${uid}-team`} className={sel} value={value.teamId ?? ""} onChange={(e) => onChange({ ...value, teamId: e.target.value || null })}>
          <option value="">—</option>
          {divisions?.map((d) => (
            <option key={d.id} value={d.id} disabled={!d.leadId}>
              {d.name}
            </option>
          ))}
        </select>
        {legacy && value.developerId && <p className="text-xs text-muted-foreground">{t("handoff.legacyDeveloper", { name: emps?.find((e) => e.id === value.developerId)?.name ?? "—" })}</p>}
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-repo`}>{t("handoff.repository")}</Label>
        <select id={`${uid}-repo`} className={sel} value={value.repositoryId ?? ""} onChange={(e) => onChange({ ...value, repositoryId: e.target.value || null })}>
          <option value="">—</option>
          {repos?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** create_routine: what the employee wants to schedule, with the rule in words and its next runs. */
export function RoutineApprovalPreview({ p }: { p: Record<string, unknown> }) {
  const t = useTranslations("approvals");
  const { data: emps } = useEmployees();
  const { data: teams } = useTeams();
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const cron = str(p.cron);
  const timezone = str(p.timezone) || "Asia/Jakarta";
  const { data: preview, pending } = useSchedulePreview(cron, timezone);
  const assigneeId = str(p.assigneeId);
  const teamId = str(p.teamId);
  const target = assigneeId
    ? (emps?.find((e) => e.id === assigneeId)?.name ?? (str(p.targetName) || assigneeId))
    : teamId
      ? (teams?.find((x) => x.id === teamId)?.name ?? (str(p.targetName) || teamId))
      : str(p.targetName);
  const overlap = p.overlap === "queue" ? "queue" : "skip";
  return (
    <div className="space-y-2 rounded-lg border bg-background p-3 text-sm">
      <div className="font-medium">{str(p.name)}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("routine.rule")}</dt>
        <dd>
          <code className="mr-2 rounded bg-muted px-1">{cron}</code>
          {!pending && preview?.valid && preview.label}
        </dd>
        <dt className="text-muted-foreground">{t("routine.timezone")}</dt>
        <dd>{timezone}</dd>
        <dt className="text-muted-foreground">{t("routine.target")}</dt>
        <dd>{target || "—"}</dd>
        <dt className="text-muted-foreground">{t("routine.overlap")}</dt>
        <dd>{t(`routine.overlapMode.${overlap}`)}</dd>
      </dl>
      <SchedulePreviewView data={preview} pending={pending} compact />
      <div>
        <div className="mb-1 text-xs text-muted-foreground">{t("routine.brief")}</div>
        <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2">{str(p.brief)}</div>
      </div>
    </div>
  );
}

/** create_skill: the SKILL.md an employee wants to save, shown as plain text (never rendered as markup). */
export function SkillApprovalPreview({ p }: { p: Record<string, unknown> }) {
  const t = useTranslations("approvals");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const body = str(p.body);
  return (
    <div className="space-y-2 rounded-lg border bg-background p-3 text-sm">
      <div className="font-medium">{t("skill.proposed", { slug: str(p.slug) })}</div>
      {str(p.employeeName) && <div className="text-xs text-muted-foreground">{t("skill.target", { name: str(p.employeeName) })}</div>}
      {!!p.untrustedInput && (
        <div className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("skill.untrusted")}</span>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-muted-foreground">{t("skill.description")}</div>
        <div className="whitespace-pre-wrap break-words">{str(p.description)}</div>
      </div>
      <details open={body.length <= 1500}>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("skill.showBody", { count: body.length })}</summary>
        <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-xs">{body}</pre>
      </details>
      <div className="text-xs text-muted-foreground">{t("skill.savedAs")}</div>
    </div>
  );
}

/** install_skill: a catalog skill at one commit, its license and files, and who gets it (approved or rejected as shown). */
export function InstallSkillApprovalPreview({ p }: { p: Record<string, unknown> }) {
  const t = useTranslations("approvals");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const body = str(p.body);
  const files = Array.isArray(p.files) ? (p.files as { path?: unknown; size?: unknown; content?: unknown; sha256?: unknown }[]) : [];
  const people = Array.isArray(p.employees) ? (p.employees as { name?: unknown }[]).map((e) => str(e?.name)).filter(Boolean) : [];
  const license = str(p.license) || str(p.licenseFile);
  return (
    <div className="space-y-2 rounded-lg border bg-background p-3 text-sm">
      <div className="font-medium">{t("installSkill.proposed", { name: str(p.name) })}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("installSkill.source")}</dt>
        <dd className="break-all">
          <a href={str(p.url)} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
            {str(p.source)}/{str(p.path)}
          </a>{" "}
          <code className="text-muted-foreground">@{str(p.commit).slice(0, 12)}</code>
        </dd>
        <dt className="text-muted-foreground">{t("installSkill.license")}</dt>
        <dd>{license || "—"}</dd>
        <dt className="text-muted-foreground">{t("installSkill.for")}</dt>
        <dd>{people.join(", ") || "—"}</dd>
      </dl>
      {!!p.untrustedInput && (
        <div className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("installSkill.untrusted")}</span>
        </div>
      )}
      {str(p.replaces) && <div className="text-xs text-warning">{t("installSkill.replaces", { slug: str(p.replaces) })}</div>}
      {str(p.reason) && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t("installSkill.reason")}</div>
          <div className="whitespace-pre-wrap break-words">{str(p.reason)}</div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-muted-foreground">{t("skill.description")}</div>
        <div className="whitespace-pre-wrap break-words">{str(p.description)}</div>
      </div>
      <details open={body.length <= 1500}>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("skill.showBody", { count: body.length })}</summary>
        <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-xs">{body}</pre>
      </details>
      {files.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("installSkill.files", { count: files.length })}</summary>
          <ul className="mt-1 space-y-1 font-mono text-xs">
            {files.map((f) => (
              <li key={str(f.path)}>
                {typeof f.content === "string" ? (
                  <details>
                    <summary className="cursor-pointer">
                      {str(f.path)} <span className="text-muted-foreground">({t("installSkill.size", { kb: Math.ceil(Number(f.size) / 1024) || 0 })})</span>
                    </summary>
                    <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2">{f.content}</pre>
                  </details>
                ) : (
                  <>
                    {str(f.path)} <span className="text-muted-foreground">({t("installSkill.size", { kb: Math.ceil(Number(f.size) / 1024) || 0 })} · {f.sha256 ? t("installSkill.notShown") : t("installSkill.notInstalled")})</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">{t("installSkill.filesNote")}</p>
        </details>
      )}
      <div className="text-xs text-muted-foreground">{t("installSkill.pinned")}</div>
    </div>
  );
}

/** create_skill in Edit & Approve: the name, description and instructions can be changed before saving. */
export function SkillApprovalEditor({ p, onChange }: { p: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const t = useTranslations("approvals");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const uid = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-slug`}>{t("skill.slug")}</Label>
        <Input id={`${uid}-slug`} className="font-mono text-sm" value={str(p.slug)} onChange={(e) => onChange({ ...p, slug: e.target.value.toLowerCase() })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-description`}>{t("skill.description")}</Label>
        <Textarea id={`${uid}-description`} rows={2} value={str(p.description)} onChange={(e) => onChange({ ...p, description: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${uid}-body`}>{t("skill.body")}</Label>
        <Textarea id={`${uid}-body`} rows={14} className="font-mono text-xs" value={str(p.body)} onChange={(e) => onChange({ ...p, body: e.target.value })} />
      </div>
    </div>
  );
}

export function PayloadPreview({ a, editing, draft, setDraft }: { a: Approval; editing: boolean; draft: Record<string, unknown>; setDraft: (v: Record<string, unknown>) => void }) {
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
        <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm tabular-nums">
          <dt className="text-muted-foreground">{t("invoice.subtotal")}</dt>
          <dd className="text-right">{f.money(invoiceSubtotal(inv), inv.currency)}</dd>
          {(inv.taxPercent ?? 0) > 0 && (
            <>
              <dt className="text-muted-foreground">{t("invoice.tax", { percent: inv.taxPercent })}</dt>
              <dd className="text-right">{f.money(invoiceTax(inv), inv.currency)}</dd>
            </>
          )}
          <dt className="border-t pt-1 font-semibold">{t("invoice.total")}</dt>
          <dd className="border-t pt-1 text-right font-semibold">{total}</dd>
        </dl>
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
  if (a.toolName === "handoff_prd") {
    // teamId/teamName since divisions; developerId/developerName in payloads made before
    const h = p as HandoffPayload;
    const target = handoffTarget(h);
    return (
      <div className="space-y-3 text-sm">
        {editing ? (
          <HandoffPicker value={handoffPick(h)} onChange={(v) => setDraft({ ...p, ...v })} />
        ) : (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <div className={cn(target.kind === "division" && "font-medium text-foreground")}>
              {target.kind === "division" ? t("handoff.toDivision", { name: target.name }) : target.kind === "developer" ? t("handoff.to", { name: target.name }) : t("handoff.noDivision")}
            </div>
            {h.resumeTaskId && <div>{t("handoff.resumes")}</div>}
          </div>
        )}
        <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border bg-background p-3">{h.prd}</div>
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
  // approved or rejected for exactly the pushed commit: never an editor
  if (a.toolName === "request_preview") return <PreviewApprovalPreview a={a} payload={a.payload} />;
  // a LIVE release: approved or rejected as proposed (the Owner only), never an editor
  if (a.toolName === "request_release") return <ReleaseApprovalPreview a={a} payload={a.payload} />;
  if (a.toolName === "create_routine" && !editing) return <RoutineApprovalPreview p={p} />;
  // a catalog skill: approved or rejected for exactly this commit and text, never an editor
  if (a.toolName === "install_skill") return <InstallSkillApprovalPreview p={a.payload as Record<string, unknown>} />;
  if (a.toolName === "create_skill") return editing ? <SkillApprovalEditor p={p} onChange={setDraft} /> : <SkillApprovalPreview p={p} />;
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
