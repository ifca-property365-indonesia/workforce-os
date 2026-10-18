"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AUTONOMY_LEVELS, type AllowListEntry, type AutonomyLevel, type ToolClass, type ToolMeta, type ToolPermission } from "@wfos/shared";
import { ChevronRight, Lock, Plus, RotateCcw, Trash2, Unlock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useMe, type Employee } from "@/lib/hooks";
import {
  mcpToolKey,
  mcpToolRules,
  normalizePermissionKey,
  parseToolSelector,
  resolveMcpTool,
  setMcpToolAutonomy,
  toggleMcpTool,
  upsertPermission,
} from "@/lib/tool-selectors";
import { cn } from "@/lib/utils";

/**
 * Granted implicitly, never shown as grantable tools: the lead-only review tools (to a team lead during review), and
 * skill_read (to every employee with at least one switched-on skill assigned; see the Skills card).
 */
const IMPLICIT_TOOLS = new Set(["request_revision", "retry_subtask", "reassign_subtask", "finish_review", "skill_read", "ask_teammate"]);

export interface McpTool {
  /** the server's own name, shown to people */
  name: string;
  /** normalised name used in `mcp:<server>:<key>` permission rules */
  key: string;
  description: string;
  class: ToolClass;
}

/** Edits are functional updates, so two quick toggles both land even before the parent re-renders. */
export type PermissionsUpdate = (update: (cur: ToolPermission[]) => ToolPermission[]) => void;

/** Cache key of one server's tool list; per workspace, since two workspaces can name a server the same. */
export const mcpToolsQueryKey = (workspaceId: string | undefined, server?: string) =>
  server === undefined ? ["mcp-tools", workspaceId] : ["mcp-tools", workspaceId, server];

/** Tools of one connected MCP server, listed live by the server (ADMIN). Shared by Settings and the employee editor. */
export function useMcpTools(server: string, enabled = true) {
  const { data: me } = useMe();
  const workspaceId = me?.workspace.id;
  return useQuery({
    queryKey: mcpToolsQueryKey(workspaceId, server),
    queryFn: () => api.get<{ tools: McpTool[] }>(`/api/settings/mcp/${encodeURIComponent(server)}/tools`),
    enabled: enabled && !!workspaceId,
    staleTime: 60_000,
    retry: false,
  });
}

function ClassBadge({ cls }: { cls: ToolClass }) {
  const t = useTranslations("employees");
  const irreversible = cls === "irreversible";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
        irreversible ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
      )}
    >
      {irreversible ? <Lock className="size-3" /> : <Unlock className="size-3" />}
      {t(`toolClass.${cls}`)}
    </span>
  );
}

function AutonomySelect({ value, onChange, inherit, className }: { value: AutonomyLevel | undefined; onChange: (v: AutonomyLevel | undefined) => void; inherit: AutonomyLevel; className?: string }) {
  const t = useTranslations("employees");
  const ts = useTranslations("status");
  return (
    <Select value={value ?? "inherit"} onValueChange={(v) => onChange(v === "inherit" ? undefined : (v as AutonomyLevel))}>
      <SelectTrigger className={cn("w-full sm:w-52", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">{t("toolPermissions.inherit", { level: ts(`autonomy.${inherit}`) })}</SelectItem>
        {AUTONOMY_LEVELS.map((l) => (
          <SelectItem key={l} value={l}>
            {ts(`autonomy.${l}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Per-tool rules under one MCP server grant: each listed tool can be switched off or given its own autonomy
 * (saved as `mcp:<server>:<normalised tool>`), and hand-typed globs (`mcp:<server>:list_*`) cover several tools at once.
 * The server-level switch stays the master grant; a matching disabled rule always wins.
 */
function McpToolsPanel({
  server,
  value,
  onChange,
  defaultAutonomy,
}: {
  server: string;
  value: ToolPermission[];
  onChange: PermissionsUpdate;
  defaultAutonomy: AutonomyLevel;
}) {
  const t = useTranslations("employees");
  const { data, error, isLoading, refetch, isFetching } = useMcpTools(server);
  /** a tool's own autonomy, kept while the panel is open so switching it off and on again does not lose it */
  const remembered = useRef(new Map<string, AutonomyLevel>());
  const [selector, setSelector] = useState("");
  const [invalid, setInvalid] = useState(false);
  const serverGrant = value.find((p) => p.tool === `mcp:${server}`);
  const granted = !!serverGrant?.enabled;
  const serverAutonomy = serverGrant?.autonomy ?? defaultAutonomy;
  const tools = data?.tools ?? [];
  const listed = new Set(tools.map((x) => mcpToolKey(server, x.key)));
  // rules saved with a raw tool name still apply (the gate normalises both sides); they are shown normalised
  const rules = mcpToolRules(value, server).filter((p) => !listed.has(normalizePermissionKey(p.tool)));
  const prefix = `mcp:${server}:`;

  const toggleTool = (tool: string, on: boolean) =>
    onChange((cur) => {
      const own = resolveMcpTool(cur, server, tool).own?.autonomy;
      if (own) remembered.current.set(tool, own);
      return toggleMcpTool(cur, server, tool, on, remembered.current.get(tool));
    });
  const setToolAutonomy = (tool: string, level: AutonomyLevel | undefined) => {
    if (level) remembered.current.set(tool, level);
    else remembered.current.delete(tool);
    onChange((cur) => setMcpToolAutonomy(cur, server, tool, level));
  };
  const setRule = (tool: string, next: Omit<ToolPermission, "tool"> | null) =>
    onChange((cur) => {
      const key = normalizePermissionKey(tool);
      return upsertPermission(cur, key, next && { tool: key, ...next });
    });
  const addRule = () => {
    const s = parseToolSelector(selector);
    if (!s) return setInvalid(true);
    const key = mcpToolKey(server, s);
    // a new rule blocks by default: the common reason to type a selector is "never these tools"
    onChange((cur) => (cur.some((p) => normalizePermissionKey(p.tool) === key) ? cur : [...cur, { tool: key, enabled: false }]));
    setSelector("");
    setInvalid(false);
  };

  return (
    <div className="space-y-3 border-t bg-muted/30 p-3 sm:pl-14">
      <p className="text-xs text-muted-foreground">{t("toolPermissions.disabledWins")}</p>
      {!granted && <p className="text-xs text-warning">{t("toolPermissions.serverNotGranted")}</p>}
      {isLoading && <p className="text-xs text-muted-foreground">{t("toolPermissions.loadingTools")}</p>}
      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{(error as Error).message}</span>
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1" onClick={() => void refetch()} disabled={isFetching}>
            <RotateCcw className="size-3" /> {t("toolPermissions.retry")}
          </Button>
        </div>
      )}
      {data && !tools.length && <p className="text-xs text-muted-foreground">{t("toolPermissions.noTools")}</p>}
      {tools.length > 0 && (
        <div className="divide-y rounded-md border bg-background">
          {tools.map((tool) => {
            const r = resolveMcpTool(value, server, tool.key);
            const inherit = r.inheritedAutonomy ?? serverAutonomy;
            return (
              <div key={`${tool.key}/${tool.name}`} className={cn("flex flex-col gap-2 p-2 sm:flex-row sm:items-center", !r.enabled && "opacity-70")}>
                <Switch
                  checked={r.enabled}
                  disabled={!granted || !!r.blockedBy}
                  onCheckedChange={(v) => toggleTool(tool.key, v)}
                  aria-label={t("toolPermissions.grant", { tool: tool.name })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <code className="font-medium">{tool.name}</code>
                    <ClassBadge cls={tool.class} />
                  </div>
                  {tool.description && <div className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</div>}
                  {r.blockedBy && <div className="text-xs text-destructive">{t("toolPermissions.blockedBy", { rule: r.blockedBy })}</div>}
                </div>
                {tool.class === "irreversible" && r.enabled && (
                  <AutonomySelect value={r.own?.autonomy} onChange={(v) => setToolAutonomy(tool.key, v)} inherit={inherit} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {rules.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">{t("toolPermissions.rules")}</div>
          <div className="divide-y rounded-md border bg-background">
            {rules.map((p) => (
              <div key={p.tool} className={cn("flex flex-col gap-2 p-2 sm:flex-row sm:items-center", !p.enabled && "opacity-70")}>
                <Switch
                  checked={p.enabled}
                  disabled={!granted && !p.enabled}
                  onCheckedChange={(v) => setRule(p.tool, { enabled: v, ...(v && p.autonomy ? { autonomy: p.autonomy } : {}) })}
                  aria-label={t("toolPermissions.grant", { tool: normalizePermissionKey(p.tool) })}
                />
                <div className="min-w-0 flex-1">
                  <code className="text-sm">{normalizePermissionKey(p.tool).slice(prefix.length)}</code>
                  <div className="text-xs text-muted-foreground">{p.enabled ? t("toolPermissions.ruleAllows") : t("toolPermissions.ruleBlocks")}</div>
                </div>
                {p.enabled && granted && (
                  <AutonomySelect
                    value={p.autonomy}
                    onChange={(v) => setRule(p.tool, { enabled: true, ...(v ? { autonomy: v } : {}) })}
                    inherit={serverAutonomy}
                  />
                )}
                <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setRule(p.tool, null)} aria-label={t("toolPermissions.removeRule", { rule: normalizePermissionKey(p.tool) })}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-1">
        <div className="flex gap-2">
          <Input
            value={selector}
            onChange={(e) => (setSelector(e.target.value), setInvalid(false))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRule();
              }
            }}
            placeholder={t("toolPermissions.selectorPlaceholder")}
            aria-invalid={invalid}
            className="h-8 font-mono text-xs"
          />
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1" onClick={addRule} disabled={!selector.trim()}>
            <Plus className="size-3.5" /> {t("toolPermissions.addRule")}
          </Button>
        </div>
        <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>{invalid ? t("toolPermissions.selectorInvalid") : t("toolPermissions.selectorHelp")}</p>
      </div>
    </div>
  );
}

export function AutonomyPicker({ value, onChange }: { value: AutonomyLevel; onChange: (v: AutonomyLevel) => void }) {
  const ts = useTranslations("status");
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {AUTONOMY_LEVELS.map((l) => (
        <button
          type="button"
          key={l}
          onClick={() => onChange(l)}
          className={cn("rounded-lg border p-3 text-left transition-colors", value === l ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-accent")}
        >
          <div className="text-sm font-semibold">{ts(`autonomy.${l}`)}</div>
          <div className="mt-1 text-xs text-muted-foreground">{ts(`autonomyDescription.${l}`)}</div>
        </button>
      ))}
    </div>
  );
}

/** Grant tools and optionally override autonomy per tool. Irreversible tools are clearly marked. */
export function ToolPermissionsEditor({
  tools,
  value,
  onChange,
  defaultAutonomy,
  extraServers = [],
}: {
  tools: ToolMeta[];
  value: ToolPermission[];
  onChange: PermissionsUpdate;
  defaultAutonomy: AutonomyLevel;
  extraServers?: string[];
}) {
  const t = useTranslations("employees");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (name: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const get = (name: string) => value.find((p) => p.tool === name);
  /** a tool granted to every task run (report_progress) is on until someone switches it off explicitly */
  const implicitOn = (tool: ToolMeta) => tool.implicit === "task" && !get(tool.name);
  const set = (name: string, patch: Partial<ToolPermission>) =>
    onChange((cur) =>
      cur.some((p) => p.tool === name) ? cur.map((p) => (p.tool === name ? { ...p, ...patch } : p)) : [...cur, { tool: name, enabled: true, ...patch }],
    );
  /** builtin tool metadata is English data; translate by tool name when a catalog entry exists */
  const rows: ToolMeta[] = [
    ...tools
      // app-test (C3) and app-document (C9) tools exist only in those tasks' runs: never granted here
      .filter((x) => !IMPLICIT_TOOLS.has(x.name) && x.implicit !== "app_test" && x.implicit !== "app_doc")
      .map((x) => ({
        ...x,
        label: t.has(`tools.${x.name}.label`) ? t(`tools.${x.name}.label`) : x.label,
        description: t.has(`tools.${x.name}.description`) ? t(`tools.${x.name}.description`) : x.description,
      })),
    ...extraServers.map((s) => ({
      name: `mcp:${s}`,
      label: t("toolPermissions.mcpServerLabel", { name: s }),
      description: t("toolPermissions.mcpServerDescription"),
      class: "irreversible" as const,
      credits: 0,
      category: "comms" as const,
    })),
  ];
  return (
    <div className="divide-y rounded-lg border">
      {rows.map((tool) => {
        const p = get(tool.name);
        const enabled = implicitOn(tool) || !!p?.enabled;
        const irreversible = tool.class === "irreversible";
        const server = tool.name.startsWith("mcp:") ? tool.name.slice(4) : null;
        const isOpen = server !== null && expanded.has(server);
        const ruleCount = server ? mcpToolRules(value, server).length : 0;
        return (
          <div key={tool.name}>
            <div className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center", !enabled && "opacity-70")}>
              <Switch checked={enabled} onCheckedChange={(v) => set(tool.name, { enabled: v })} aria-label={t("toolPermissions.grant", { tool: tool.label })} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {tool.label}
                  <ClassBadge cls={tool.class} />
                </div>
                <div className="text-xs text-muted-foreground">
                  {tool.description} · {t(`toolCategories.${tool.category}`)} · <code>{tool.name}</code>
                </div>
                {tool.implicit === "task" && <div className="text-xs text-muted-foreground">{t("toolPermissions.implicitTask")}</div>}
              </div>
              {server !== null && (
                <Button type="button" size="sm" variant="ghost" className="gap-1 self-start sm:self-auto" onClick={() => toggleExpanded(server)} aria-expanded={isOpen}>
                  <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
                  {ruleCount ? t("toolPermissions.perToolCount", { count: ruleCount }) : t("toolPermissions.perTool")}
                </Button>
              )}
              {irreversible && enabled && (
                <AutonomySelect value={p?.autonomy} onChange={(v) => set(tool.name, { autonomy: v })} inherit={defaultAutonomy} />
              )}
            </div>
            {isOpen && server !== null && <McpToolsPanel server={server} value={value} onChange={onChange} defaultAutonomy={defaultAutonomy} />}
          </div>
        );
      })}
    </div>
  );
}

const EMAIL_TOOLS = new Set(["send_email", "send_invoice"]);
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * One allow-list scope. For email tools, the recipient rules: domains, exact addresses, and "on the client's file"
 * (the payload's client: its main email or a contact). Once any of them is set, every recipient must match one.
 */
function AllowListScope({
  entry,
  tools,
  canEdit,
  onChange,
  onRemove,
  index,
}: {
  entry: AllowListEntry;
  tools: string[];
  canEdit: boolean;
  onChange: (next: AllowListEntry) => void;
  onRemove: () => void;
  index: number;
}) {
  const t = useTranslations("employees");
  const email = EMAIL_TOOLS.has(entry.tool);
  const id = (k: string) => `allow-${index}-${k}`;
  const ruled = entry.recipientDomains.length > 0 || (entry.recipients?.length ?? 0) > 0 || entry.clientContactsOnly === true;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Select disabled={!canEdit} value={entry.tool} onValueChange={(v) => onChange({ ...entry, tool: v })}>
          <SelectTrigger className="min-w-0 flex-1 sm:max-w-72" aria-label={t("allowList.tool")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...new Set([entry.tool, ...tools])].map((tool) => (
              <SelectItem key={tool} value={tool}>
                {tool}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="ml-auto" disabled={!canEdit} onClick={onRemove} aria-label={t("allowList.removeScope")}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      {email && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={id("domains")} className="text-xs">
              {t("allowList.recipientDomainsLabel")}
            </Label>
            <Input
              id={id("domains")}
              disabled={!canEdit}
              placeholder={t("allowList.recipientDomains")}
              defaultValue={entry.recipientDomains.join(", ")}
              onBlur={(x) => onChange({ ...entry, recipientDomains: list(x.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("recipients")} className="text-xs">
              {t("allowList.recipientsLabel")}
            </Label>
            <Input
              id={id("recipients")}
              disabled={!canEdit}
              placeholder={t("allowList.recipients")}
              defaultValue={(entry.recipients ?? []).join(", ")}
              onBlur={(x) => onChange({ ...entry, recipients: list(x.target.value) })}
            />
          </div>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Switch className="mt-0.5" disabled={!canEdit} checked={entry.clientContactsOnly === true} onCheckedChange={(v) => onChange({ ...entry, clientContactsOnly: v })} />
            <span>
              <span className="font-medium">{t("allowList.clientContactsOnly")}</span>
              <span className="block text-xs text-muted-foreground">{t("allowList.clientContactsOnlyHelp")}</span>
            </span>
          </label>
          <p className={cn("text-xs sm:col-span-2", ruled ? "text-muted-foreground" : "text-warning")}>{ruled ? t("allowList.recipientRule") : t("allowList.noRecipientRule")}</p>
        </div>
      )}
      {entry.tool === "send_invoice" && (
        <div className="space-y-1.5 sm:max-w-60">
          <Label htmlFor={id("max")} className="text-xs">
            {t("allowList.maxAmount")}
          </Label>
          <Input
            id={id("max")}
            disabled={!canEdit}
            type="number"
            min={0}
            value={entry.maxAmount ?? ""}
            onChange={(x) => onChange({ ...entry, maxAmount: x.target.value ? Number(x.target.value) : undefined })}
          />
        </div>
      )}
    </div>
  );
}

/** The Owner allow-list: scopes in which irreversible actions run without a per-action approval (CLOSE autonomy only). */
export function AllowListEditor({ e, canEdit }: { e: Employee; canEdit: boolean }) {
  const t = useTranslations("employees");
  const ts = useTranslations("status");
  const qc = useQueryClient();
  const [entries, setEntries] = useState<AllowListEntry[]>(e.allowList);
  /** a key per scope, so removing one does not hand its typed-in text to the next */
  const keys = useRef<number[]>(e.allowList.map((_, i) => i));
  const nextKey = useRef(e.allowList.length);
  const tools = e.toolPermissions.filter((p) => p.enabled && (["send_email", "send_invoice", "post_webhook"].includes(p.tool) || p.tool.startsWith("mcp:"))).map((p) => p.tool);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/employees/${e.id}`, { allowList: entries }),
    onSuccess: () => {
      toast.success(t("allowList.saved"));
      void qc.invalidateQueries({ queryKey: ["employee", e.id] });
    },
    onError: (x) => toast.error((x as Error).message),
  });
  const remove = (i: number) => {
    keys.current = keys.current.filter((_, j) => j !== i);
    setEntries(entries.filter((_, j) => j !== i));
  };
  const add = () => {
    keys.current = [...keys.current, nextKey.current++];
    setEntries([...entries, { tool: tools[0]!, recipientDomains: [], clientIds: [] }]);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("allowList.title")}</CardTitle>
        <CardDescription>
          {t("allowList.description", { level: ts("autonomy.CLOSE") })} {canEdit ? null : t("allowList.ownerOnly")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map((entry, i) => (
          <AllowListScope
            key={keys.current[i]}
            index={keys.current[i]!}
            entry={entry}
            tools={tools}
            canEdit={canEdit}
            onChange={(next) => setEntries((cur) => cur.map((x, j) => (j === i ? next : x)))}
            onRemove={() => remove(i)}
          />
        ))}
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!tools.length} onClick={add} className="gap-1">
              <Plus className="size-3.5" /> {t("allowList.addScope")}
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {t("allowList.save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
