"use client";

import { useRouter } from "next/navigation";
import { ChangePasswordForm } from "@/components/account/change-password-form";

export function ForcedChange() {
  const router = useRouter();
  return <ChangePasswordForm submitLabel="Save and continue" onDone={() => router.replace("/dashboard")} />;
}
