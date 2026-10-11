import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audit, credentials, db } from "@wfos/db";
import type { McpCredentialConfig } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";
import { assertMcpServerName } from "@/lib/server/mcp";
import { mcpOAuthNeedsReconnect } from "@/lib/server/mcp-oauth-refresh";
import { body, route } from "@/lib/server/route";

export const GET = route("ADMIN", async ({ session }) => {
  const rows = await db.select().from(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "mcp")));
  return {
    servers: rows.map((r) => {
      const cfg = r.config as McpCredentialConfig;
      const oauth = cfg.auth === "oauth";
      return {
        id: r.id,
        name: r.name,
        url: cfg.url,
        tokenSet: !!r.secretEnc,
        auth: oauth ? ("oauth" as const) : ("token" as const),
        // the sign-in has to be redone: its refresh was refused, or the token ran out with nothing to refresh it
        // (an expired token that can be refreshed is refreshed on its next use)
        needsReconnect: mcpOAuthNeedsReconnect(r),
        // an import left this slot unconfigured: never contacted until an Owner saves it (and adds its token)
        disabled: cfg.disabled === true,
      };
    }),
  };
});

const schema = z.object({
  name: z.string(),
  url: z.url(),
  token: z.string().optional(),
  authHeader: z.string().optional(),
});

export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, schema);
  assertMcpServerName(input.name);
  const config = { url: input.url, ...(input.authHeader ? { authHeader: input.authHeader } : {}) };
  const secretEnc = input.token ? encryptSecret(input.token) : null;
  await db
    .insert(credentials)
    .values({ workspaceId: session.workspaceId, kind: "mcp", name: input.name, config, secretEnc })
    .onConflictDoUpdate({
      target: [credentials.workspaceId, credentials.kind, credentials.name],
      // replacing an OAuth server by a plain one without a token drops its OAuth tokens (they are not a plain token)
      set: { config, secretEnc: secretEnc ?? sql`CASE WHEN ${credentials.config}->>'auth' = 'oauth' THEN NULL ELSE ${credentials.secretEnc} END` },
    });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.mcp_connected", targetType: "credential", targetId: input.name, details: { url: input.url, tokenChanged: !!input.token } });
  return { ok: true };
});

export const DELETE = route("OWNER", async ({ session, req }) => {
  const name = req.nextUrl.searchParams.get("name") ?? "";
  await db.delete(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "mcp"), eq(credentials.name, name)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.mcp_removed", targetType: "credential", targetId: name });
  return { ok: true };
});
