"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Globe, KeyRound } from "lucide-react";
import { APP_SLUG_RE, RESERVED_APP_SLUGS, type AppAccessMode, type AppDTO } from "@wfos/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { serversQueryKey, type Server } from "@/components/settings/servers";
import { api } from "@/lib/api";
import { useClients } from "@/lib/hooks";
import Link, { useRouter } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { appsQueryKey, selectClass } from "./shared";

export interface Repository {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
}

/** the same cache entry as Settings → Servers (same key, same response), read as the list */
export const useServers = () =>
  useQuery({ queryKey: serversQueryKey, queryFn: () => api.get<{ servers: Server[]; allowPrivate: boolean }>("/api/servers"), select: (r) => r.servers });
export const useRepositories = (enabled = true) =>
  useQuery({ queryKey: ["repositories"], queryFn: () => api.get<{ repositories: Repository[] }>("/api/repositories").then((r) => r.repositories), enabled });

/** "Customer Portal 2" → "customer-portal-2" (what the subdomain field suggests until a person types in it) */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

/** null when fine, else the reason the subdomain is refused (the API refuses the same) */
export function slugProblem(slug: string): "invalid" | "reserved" | null {
  if (!APP_SLUG_RE.test(slug) || slug.includes("--")) return "invalid";
  // <slug>-live is the instance name of an app's live environment
  if ((RESERVED_APP_SLUGS as readonly string[]).includes(slug) || slug.endsWith("-live")) return "reserved";
  return null;
}

/** An app's essentials; the address is shown live as the subdomain is typed. Its page opens next. */
export function NewAppDialog({ onClose, defaultClientId }: { onClose: () => void; defaultClientId?: string | null }) {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const router = useRouter();
  const uid = useId();
  const servers = useServers();
  const repos = useRepositories();
  const { data: clients } = useClients();
  const ready = (servers.data ?? []).filter((s) => s.status === "ready");
  const [f, setF] = useState({ name: "", slug: "", slugTouched: false, serverId: "", repositoryId: "", branch: "", clientId: defaultClientId ?? "", projectId: "", accessMode: "password" as AppAccessMode });
  const serverId = f.serverId || ready[0]?.id || "";
  const repositoryId = f.repositoryId || repos.data?.[0]?.id || "";
  const server = ready.find((s) => s.id === serverId);
  const repo = repos.data?.find((r) => r.id === repositoryId);
  const slug = f.slugTouched ? f.slug : slugify(f.name);
  const problem = slug ? slugProblem(slug) : null;
  const projects = clients?.find((c) => c.id === f.clientId)?.projects ?? [];

  const m = useMutation({
    mutationFn: () =>
      api.post<{ app: AppDTO }>("/api/apps", {
        name: f.name.trim(),
        slug,
        serverId,
        repositoryId,
        ...(f.branch.trim() && { branch: f.branch.trim() }),
        clientId: f.clientId || null,
        projectId: f.projectId || null,
        accessMode: f.accessMode,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: appsQueryKey });
      toast.success(t("form.created"));
      onClose();
      router.push(`/apps/${r.app.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = !!f.name.trim() && !!slug && !problem && !!server && !!repo;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("form.title")}</DialogTitle>
          <DialogDescription>{t("form.description")}</DialogDescription>
        </DialogHeader>
        <form
          id={`${uid}-form`}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) m.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>{t("form.name")}</Label>
            <Input id={`${uid}-name`} autoFocus maxLength={80} value={f.name} placeholder={t("form.namePlaceholder")} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-slug`}>{t("form.slug")}</Label>
            <Input
              id={`${uid}-slug`}
              value={slug}
              maxLength={30}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              aria-invalid={!!problem}
              aria-describedby={`${uid}-slug-help`}
              onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase(), slugTouched: true })}
            />
            <p id={`${uid}-slug-help`} className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
              {problem === "reserved" ? t("form.slugReserved", { slug }) : problem ? t("form.slugInvalid") : t("form.slugHelp")}
            </p>
            {/* the address plate: what people will type, as soon as there is something to show */}
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2">
              <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="sr-only">{t("form.address")}</span>
              <code className="min-w-0 truncate font-mono text-sm">
                {/* i18n-ignore: the scheme of a URL */}
                <span className="text-muted-foreground">https://</span>
                <span className={cn("font-semibold", problem && "text-destructive")}>{slug || "…"}</span>
                <span className="text-muted-foreground">.{server?.baseDomain ?? "…"}</span>
              </code>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-server`}>{t("form.server")}</Label>
              <select id={`${uid}-server`} className={selectClass} value={serverId} disabled={!ready.length} onChange={(e) => setF({ ...f, serverId: e.target.value })}>
                {ready.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-repo`}>{t("form.repository")}</Label>
              <select
                id={`${uid}-repo`}
                className={selectClass}
                value={repositoryId}
                disabled={!repos.data?.length}
                onChange={(e) => setF({ ...f, repositoryId: e.target.value, branch: "" })}
              >
                {repos.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {servers.data && !ready.length && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
              {t("form.noServer")}{" "}
              <Link href="/settings?tab=servers" className="font-semibold underline underline-offset-2" onClick={onClose}>
                {t("empty.openServers")}
              </Link>
            </p>
          )}
          {repos.data && !repos.data.length && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
              {t("form.noRepository")}{" "}
              <Link href="/settings?tab=repositories" className="font-semibold underline underline-offset-2" onClick={onClose}>
                {t("empty.openRepositories")}
              </Link>
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-branch`}>{t("form.branch")}</Label>
            <Input
              id={`${uid}-branch`}
              value={f.branch}
              maxLength={200}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              placeholder={repo?.defaultBranch ?? "main"}
              aria-describedby={`${uid}-branch-help`}
              onChange={(e) => setF({ ...f, branch: e.target.value })}
            />
            <p id={`${uid}-branch-help`} className="text-xs text-muted-foreground">
              {t("form.branchHelp")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-client`}>{t("form.client")}</Label>
              <select id={`${uid}-client`} className={selectClass} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value, projectId: "" })}>
                <option value="">{t("form.none")}</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-project`}>{t("form.project")}</Label>
              <select id={`${uid}-project`} className={selectClass} value={f.projectId} disabled={!projects.length} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">{t("form.none")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <AccessModePicker value={f.accessMode} onChange={(accessMode) => setF({ ...f, accessMode })} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!valid || m.isPending}>
            {t("form.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** password (the default) or public, as two cards with what each means */
export function AccessModePicker({ value, onChange }: { value: AppAccessMode; onChange: (v: AppAccessMode) => void }) {
  const t = useTranslations("apps");
  const name = useId();
  const options = [
    { v: "password" as const, icon: KeyRound, label: t("form.accessPassword"), help: t("form.accessPasswordHelp") },
    { v: "public" as const, icon: Globe, label: t("form.accessPublic"), help: t("form.accessPublicHelp") },
  ];
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{t("form.access")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.v}
            className={cn(
              "flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === o.v ? "border-foreground bg-secondary/60" : "hover:bg-secondary/40",
            )}
          >
            <input type="radio" name={name} value={o.v} checked={value === o.v} onChange={() => onChange(o.v)} className="sr-only" />
            <o.icon className={cn("mt-0.5 size-4 shrink-0", value === o.v ? "text-foreground" : "text-muted-foreground")} aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.help}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
