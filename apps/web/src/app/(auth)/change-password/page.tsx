import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "next-intl/server";
import { ForcedChange } from "./forced-change";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mustChangePassword) redirect("/dashboard");
  const t = await getTranslations("auth");
  return (
    <Card className="w-full max-w-sm rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display text-[2.1rem]">{t("changePassword.title")}</CardTitle>
        <CardDescription>{t("changePassword.description", { email: session.email })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ForcedChange />
      </CardContent>
    </Card>
  );
}
