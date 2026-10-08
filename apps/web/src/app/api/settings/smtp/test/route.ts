import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { credentials, db } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { sendMail } from "@wfos/shared/mail";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

const schema = z.object({ to: z.email() });

export const POST = route("ADMIN", async ({ session, req }) => {
  const { to } = await body(req, schema);
  const [c] = await db.select().from(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "smtp"), eq(credentials.name, "default")));
  if (!c) throw new HttpError(400, "Save SMTP settings first", { code: "smtp_not_configured" });
  const cfg = c.config as { host: string; port: number; secure: boolean; user: string; fromAddress: string };
  try {
    const r = await sendMail(
      { ...cfg, password: c.secretEnc ? decryptSecret(c.secretEnc) : "" },
      { to: [to], subject: "Workforce OS — SMTP test", text: `This is a test email from Workforce OS (${session.workspaceName}). SMTP is working.` },
    );
    return { ok: true, messageId: r.messageId };
  } catch (e) {
    throw new HttpError(422, `SMTP test failed: ${(e as Error).message}`, { code: "smtp_test_failed", detail: (e as Error).message });
  }
});
