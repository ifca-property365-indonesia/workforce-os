import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, credentials, db } from "@wfos/db";
import { encryptSecret } from "@wfos/shared/server";
import { HttpError } from "@/lib/server/auth";
import { body, route } from "@/lib/server/route";

/**
 * Same rule as the shared permission schema's `mcp:<server>`: [a-z0-9-] parts joined by single "_", 2–32 chars.
 * "__" is refused because the Claude SDK names MCP tools `mcp__<server>__<tool>`, so it would split the name.
 */
const MCP_SERVER_NAME_RE = /^(?=.{2,32}$)[a-z0-9-]+(?:_[a-z0-9-]+)*$/;

export const GET = route("ADMIN", async ({ session }) => {
  const rows = await db.select().from(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "mcp")));
  return { servers: rows.map((r) => ({ id: r.id, name: r.name, url: (r.config as { url: string }).url, tokenSet: !!r.secretEnc })) };
});

const schema = z.object({
  name: z.string(),
  url: z.url(),
  token: z.string().optional(),
  authHeader: z.string().optional(),
});

export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, schema);
  if (!MCP_SERVER_NAME_RE.test(input.name)) throw new HttpError(400, "Invalid MCP server name", { code: "mcp_invalid_name" });
  const config = { url: input.url, ...(input.authHeader ? { authHeader: input.authHeader } : {}) };
  const secretEnc = input.token ? encryptSecret(input.token) : null;
  await db
    .insert(credentials)
    .values({ workspaceId: session.workspaceId, kind: "mcp", name: input.name, config, secretEnc })
    .onConflictDoUpdate({ target: [credentials.workspaceId, credentials.kind, credentials.name], set: { config, ...(secretEnc ? { secretEnc } : {}) } });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.mcp_connected", targetType: "credential", targetId: input.name, details: { url: input.url, tokenChanged: !!input.token } });
  return { ok: true };
});

export const DELETE = route("OWNER", async ({ session, req }) => {
  const name = req.nextUrl.searchParams.get("name") ?? "";
  await db.delete(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "mcp"), eq(credentials.name, name)));
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "credential.mcp_removed", targetType: "credential", targetId: name });
  return { ok: true };
});
