import { eq } from "drizzle-orm";
import { z } from "zod";
import { LOCALES, isTimeZone } from "@wfos/shared";
import { audit, claudeCredentialStatus, db, workspaces } from "@wfos/db";
import { encryptSecret } from "@wfos/shared/server";
import { body, route } from "@/lib/server/route";
import { claudeSummary } from "@/lib/server/claude";
import { HttpError } from "@/lib/server/auth";

export const GET = route("VIEWER", async ({ session }) => {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
  return {
    workspace: {
      id: ws!.id,
      name: ws!.name,
      monthlyBudget: ws!.monthlyBudget,
      guardsEnabled: ws!.guardsEnabled,
      demoMode: ws!.demoMode,
      killSwitch: ws!.killSwitch,
      notifyEmail: ws!.notifyEmail,
      webhookConfigured: !!ws!.webhookUrlEnc,
      require2faAdmins: ws!.require2faAdmins,
      defaultLocale: ws!.defaultLocale,
      timezone: ws!.timezone,
    },
    claude: claudeSummary(await claudeCredentialStatus(session.workspaceId)),
  };
});

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  monthlyBudget: z.number().nonnegative().max(10_000_000).optional(),
  guardsEnabled: z.boolean().optional(),
  demoMode: z.boolean().optional(),
  notifyEmail: z.email().or(z.literal("")).optional(),
  webhookUrl: z.url().or(z.literal("")).optional(),
  require2faAdmins: z.boolean().optional(),
  /** workspace language for the UI default and employee output; null = follow each browser */
  defaultLocale: z.enum(LOCALES).nullable().optional(),
  timezone: z.string().refine(isTimeZone, "an IANA time zone such as Asia/Jakarta").optional(),
});

export const PUT = route("ADMIN", async ({ session, req }) => {
  const input = await body(req, schema);
  if (input.require2faAdmins !== undefined && session.role !== "OWNER") {
    throw new HttpError(403, "Only an Owner can change the two-factor requirement", { code: "owner_only" });
  }
  const { webhookUrl, notifyEmail, ...rest } = input;
  const set: Partial<typeof workspaces.$inferInsert> = { ...rest };
  if (notifyEmail !== undefined) set.notifyEmail = notifyEmail || null;
  if (webhookUrl !== undefined) set.webhookUrlEnc = webhookUrl ? encryptSecret(webhookUrl) : null;
  await db.update(workspaces).set(set).where(eq(workspaces.id, session.workspaceId));
  const details: Record<string, unknown> = { ...rest };
  if (webhookUrl !== undefined) details.webhook = webhookUrl ? "updated" : "removed";
  if (notifyEmail !== undefined) details.notifyEmail = notifyEmail;
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action:
      webhookUrl !== undefined
        ? "credential.webhook_changed"
        : input.require2faAdmins !== undefined
          ? "settings.2fa_requirement_changed"
          : input.guardsEnabled !== undefined
            ? "settings.guards_changed"
            : "settings.updated",
    targetType: "workspace",
    targetId: session.workspaceId,
    details,
  });
  return { ok: true };
});
