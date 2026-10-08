import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ForcedEnroll } from "./forced-enroll";

export const dynamic = "force-dynamic";

export default async function SetupTwoFactorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/change-password");
  if (!session.mustEnroll2fa) redirect("/dashboard");
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Set up two-factor authentication</CardTitle>
        <CardDescription>{session.workspaceName} requires two-factor authentication for Owners and Admins. Set it up to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <ForcedEnroll />
      </CardContent>
    </Card>
  );
}
