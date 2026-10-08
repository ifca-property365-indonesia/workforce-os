"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChangePasswordForm } from "@/components/account/change-password-form";

export function ForcedChange() {
  const t = useTranslations("auth");
  const router = useRouter();
  return <ChangePasswordForm submitLabel={t("changePassword.submit")} onDone={() => router.replace("/dashboard")} />;
}
