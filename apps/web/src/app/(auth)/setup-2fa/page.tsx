import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "next-intl/server";
import { ForcedEnroll } from "./forced-enroll";

export const dynamic = "force-dynamic";

export default async function SetupTwoFactorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  if (!session.mustEnroll2fa) redirect("/dashboard");
  const t = await getTranslations("auth");
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">{t("setup2fa.title")}</CardTitle>
        <CardDescription>{t("setup2fa.description", { workspace: session.workspaceName })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ForcedEnroll />
      </CardContent>
    </Card>
  );
}
