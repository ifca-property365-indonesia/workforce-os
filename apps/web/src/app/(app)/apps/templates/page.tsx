"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/layout/common";
import { useAppRights } from "@/components/apps/shared";
import { UiTemplateGallery } from "@/components/apps/ui-templates";

/** C5: Apps → UI templates: the kits the app builders follow, each with a live preview. */
export default function UiTemplatesPage() {
  const t = useTranslations("apps.templates");
  const { admin } = useAppRights();
  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      <UiTemplateGallery admin={admin} />
    </div>
  );
}
