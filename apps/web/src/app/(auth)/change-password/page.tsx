import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ForcedChange } from "./forced-change";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mustChangePassword) redirect("/dashboard");
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Choose your password</CardTitle>
        <CardDescription>
          {session.email} was created with a temporary password. Pick your own to continue. Enter the temporary password as the current one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ForcedChange />
      </CardContent>
    </Card>
  );
}
