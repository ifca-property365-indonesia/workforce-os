"use client";

import { AUTONOMY_LEVELS, AUTONOMY_DESCRIPTIONS, type AutonomyLevel, type ToolMeta, type ToolPermission } from "@wfos/shared";
import { Lock, Unlock } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function AutonomyPicker({ value, onChange }: { value: AutonomyLevel; onChange: (v: AutonomyLevel) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {AUTONOMY_LEVELS.map((l) => (
        <button
          type="button"
          key={l}
          onClick={() => onChange(l)}
          className={cn("rounded-lg border p-3 text-left transition-colors", value === l ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-accent")}
        >
          <div className="text-sm font-semibold">{l}</div>
          <div className="mt-1 text-xs text-muted-foreground">{AUTONOMY_DESCRIPTIONS[l]}</div>
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
  onChange: (v: ToolPermission[]) => void;
  defaultAutonomy: AutonomyLevel;
  extraServers?: string[];
}) {
  const get = (name: string) => value.find((p) => p.tool === name);
  const set = (name: string, patch: Partial<ToolPermission>) => {
    const cur = get(name);
    if (cur) onChange(value.map((p) => (p.tool === name ? { ...p, ...patch } : p)));
    else onChange([...value, { tool: name, enabled: true, ...patch }]);
  };
  const rows = [
    ...tools.filter((t) => t.name !== "request_revision"),
    ...extraServers.map((s) => ({ name: `mcp:${s}`, label: `MCP server: ${s}`, description: "All tools of this connected MCP server (classified by verb; unknown = irreversible)", class: "irreversible" as const, credits: 0, category: "comms" as const })),
  ];
  return (
    <div className="divide-y rounded-lg border">
      {rows.map((t) => {
        const p = get(t.name);
        const enabled = !!p?.enabled;
        const irreversible = t.class === "irreversible";
        return (
          <div key={t.name} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center", !enabled && "opacity-70")}>
            <Switch checked={enabled} onCheckedChange={(v) => set(t.name, { enabled: v })} aria-label={`Grant ${t.label}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {t.label}
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    irreversible ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {irreversible ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                  {t.class}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {t.description} · <code>{t.name}</code>
              </div>
            </div>
            {irreversible && enabled && (
              <Select value={p?.autonomy ?? "inherit"} onValueChange={(v) => set(t.name, { autonomy: v === "inherit" ? undefined : (v as AutonomyLevel) })}>
                <SelectTrigger className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Inherit ({defaultAutonomy})</SelectItem>
                  {AUTONOMY_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}
