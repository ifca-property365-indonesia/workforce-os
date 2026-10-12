"use client";

import { useEffect, useState } from "react";
import Link from "@/lib/nav";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SKILLS_QK, SkillSourceBadge, UntrustedBadge, useSkills } from "@/components/settings/skills";
import { api } from "@/lib/api";

/** Employee detail → Skills: which of the workspace's skills this employee may read (skill_read). */
export function EmployeeSkillsCard({ employeeId, admin }: { employeeId: string; admin: boolean }) {
  const t = useTranslations("skills");
  const qc = useQueryClient();
  const { data: all } = useSkills();
  const qk = ["employee-skills", employeeId];
  const { data: assigned } = useQuery({ queryKey: qk, queryFn: () => api.get<{ skills: { id: string }[] }>(`/api/employees/${employeeId}/skills`).then((r) => r.skills.map((s) => s.id)) });
  const [picked, setPicked] = useState<string[] | null>(null);
  useEffect(() => setPicked(null), [assigned]);
  const current = picked ?? assigned ?? [];
  const dirty = picked !== null && (picked.length !== (assigned ?? []).length || picked.some((id) => !(assigned ?? []).includes(id)));
  const save = useMutation({
    mutationFn: () => api.put(`/api/employees/${employeeId}/skills`, { skillIds: current }),
    onSuccess: () => {
      toast.success(t("employee.saved"));
      void qc.invalidateQueries({ queryKey: qk });
      void qc.invalidateQueries({ queryKey: SKILLS_QK });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const active = (assigned ?? []).length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("employee.title")}</CardTitle>
        <CardDescription>
          {t("employee.description")} {t("employee.toolNote")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className={active ? "text-xs text-success" : "text-xs text-muted-foreground"}>{active ? t("employee.toolActive") : t("employee.toolInactive")}</p>
        {all && !all.length && <p className="text-muted-foreground">{t("employee.none")}</p>}
        <ul className="space-y-2">
          {all?.map((s) => (
            <li key={s.id}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!admin}
                  checked={current.includes(s.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...current, s.id] : current.filter((x) => x !== s.id))}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="font-medium">{s.slug}</code>
                    <SkillSourceBadge source={s.source} />
                    {s.untrusted && <UntrustedBadge />}
                    {!s.enabled && <span className="text-xs text-muted-foreground">· {t("employee.off")}</span>}
                  </span>
                  <span className="block break-words text-xs text-muted-foreground">{s.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {admin && (
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {t("employee.save")}
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link href="/settings?tab=skills">{t("employee.manage")}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
