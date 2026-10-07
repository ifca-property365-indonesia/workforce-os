import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, credentials, db } from "@wfos/db";
import { encryptSecret } from "@wfos/shared/server";
import { body, route } from "@/lib/server/route";

export const GET = route("ADMIN", async ({ session }) => {
  const rows = await db.select().from(credentials).where(and(eq(credentials.workspaceId, session.workspaceId), eq(credentials.kind, "mcp")));
  return { servers: rows.map((r) => ({ id: r.id, name: r.name, url: (r.config as { url: string }).url, tokenSet: !!r.secretEnc })) };
});

const schema = z.object({
  name: z.string().regex(/^[a-z0-9_-]{2,32}$/, "lowercase letters, digits, - and _ only"),
  url: z.url(),
  token: z.string().optional(),
  authHeader: z.string().optional(),
});

export const POST = route("OWNER", async ({ session, req }) => {
  const input = await body(req, schema);
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
