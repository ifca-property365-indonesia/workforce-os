"use client";

import Link from "next/link";
import { use } from "react";
import { useTranslations } from "next-intl";
import { TaskDetail } from "@/components/inspector/task-detail";

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("tasks");
  return (
    <div className="space-y-4">
      <Link href="/tasks" className="text-sm text-muted-foreground hover:text-foreground">
        ← {t("page.back")}
      </Link>
      <TaskDetail taskId={id} />
    </div>
  );
}
