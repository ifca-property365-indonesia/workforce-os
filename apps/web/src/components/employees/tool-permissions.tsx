"use client";

import { AUTONOMY_LEVELS, type AutonomyLevel, type ToolMeta, type ToolPermission } from "@wfos/shared";
import { Lock, Unlock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

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
  onChange: (v: ToolPermission[]) => void;
  defaultAutonomy: AutonomyLevel;
  extraServers?: string[];
}) {
  const t = useTranslations("employees");
  const ts = useTranslations("status");
  const get = (name: string) => value.find((p) => p.tool === name);
  const set = (name: string, patch: Partial<ToolPermission>) => {
    const cur = get(name);
    if (cur) onChange(value.map((p) => (p.tool === name ? { ...p, ...patch } : p)));
    else onChange([...value, { tool: name, enabled: true, ...patch }]);
  };
  /** builtin tool metadata is English data; translate by tool name when a catalog entry exists */
  const rows: ToolMeta[] = [
    ...tools
      .filter((x) => x.name !== "request_revision")
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
        const enabled = !!p?.enabled;
        const irreversible = tool.class === "irreversible";
        return (
          <div key={tool.name} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center", !enabled && "opacity-70")}>
            <Switch checked={enabled} onCheckedChange={(v) => set(tool.name, { enabled: v })} aria-label={t("toolPermissions.grant", { tool: tool.label })} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {tool.label}
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                    irreversible ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  {irreversible ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                  {t(`toolClass.${tool.class}`)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {tool.description} · {t(`toolCategories.${tool.category}`)} · <code>{tool.name}</code>
              </div>
            </div>
            {irreversible && enabled && (
              <Select value={p?.autonomy ?? "inherit"} onValueChange={(v) => set(tool.name, { autonomy: v === "inherit" ? undefined : (v as AutonomyLevel) })}>
                <SelectTrigger className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{t("toolPermissions.inherit", { level: ts(`autonomy.${defaultAutonomy}`) })}</SelectItem>
                  {AUTONOMY_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {ts(`autonomy.${l}`)}
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
