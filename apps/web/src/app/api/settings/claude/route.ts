import { z } from "zod";
import { audit, claudeCredentialStatus, removeClaudeCredential, setClaudeCredential } from "@wfos/db";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

/** Status only: type, last 4 characters and which credential is in effect. The secret never leaves the server. */
export const GET = route("ADMIN", async ({ session }) => claudeCredentialStatus(session.workspaceId));

const schema = z.object({
  type: z.enum(["oauth", "api_key"]),
  secret: z
    .string()
    .trim()
    .min(20)
    .max(500)
    .regex(/^\S+$/, "Must not contain spaces"),
});

export const PUT = route("OWNER", async ({ session, req }) => {
  const { type, secret } = await body(req, schema);
  // catch the common mix-up of pasting an API key as a subscription token or the other way round
  if (type === "oauth" && secret.startsWith("sk-ant-api")) throw new HttpError(400, "This looks like an API key; choose the API key type", { code: "claude_credential_type_mismatch" });
  if (type === "api_key" && secret.startsWith("sk-ant-oat")) throw new HttpError(400, "This looks like a subscription token; choose the subscription type", { code: "claude_credential_type_mismatch" });
  await setClaudeCredential(session.workspaceId, type, secret);
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "credential.claude_set",
    targetType: "workspace",
    targetId: session.workspaceId,
    details: { type, last4: secret.slice(-4) },
  });
  return claudeCredentialStatus(session.workspaceId);
});

export const DELETE = route("OWNER", async ({ session }) => {
  await removeClaudeCredential(session.workspaceId);
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.claude_removed", targetType: "workspace", targetId: session.workspaceId });
  return claudeCredentialStatus(session.workspaceId);
});
