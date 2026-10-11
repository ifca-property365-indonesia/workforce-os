import { and, desc, eq, gt, isNull, or, count } from "drizzle-orm";
import { z } from "zod";
import { apiTokens, audit, db, users } from "@wfos/db";
import { hasRole } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { generateApiToken } from "@/lib/server/api-token";
import { body, route } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { serverEnv } from "@/lib/server/env";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const MAX_ACTIVE_PER_USER = 20;

const publicCols = {
  id: apiTokens.id,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  scopes: apiTokens.scopes,
  createdAt: apiTokens.createdAt,
  lastUsedAt: apiTokens.lastUsedAt,
  expiresAt: apiTokens.expiresAt,
  revokedAt: apiTokens.revokedAt,
  markUntrusted: apiTokens.markUntrusted,
};

/** Your own tokens in this workspace; `?all=1` (OWNER/ADMIN) lists every member's tokens. Never the token itself. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const mcpUrl = `${serverEnv.appUrl.replace(/\/+$/, "")}/api/mcp`;
  if (req.nextUrl.searchParams.get("all") === "1") {
    if (!hasRole(session.role, "ADMIN")) throw new HttpError(403, "Requires ADMIN role", { code: "role_required", role: "ADMIN" });
    const rows = await db
      .select({ ...publicCols, user: { id: users.id, name: users.name, email: users.email } })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.workspaceId, session.workspaceId))
      .orderBy(desc(apiTokens.createdAt))
      .limit(500);
    return { tokens: rows, mcpUrl };
  }
  const rows = await db
    .select(publicCols)
    .from(apiTokens)
    .where(and(eq(apiTokens.workspaceId, session.workspaceId), eq(apiTokens.userId, session.userId)))
    .orderBy(desc(apiTokens.createdAt))
    .limit(200);
  return { tokens: rows, mcpUrl };
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** days until the token expires: every token expires, a year at most (no "never", not even for an Owner) */
  expiresInDays: z.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
  /** tasks and chat messages this token creates start tainted (recommended for machine clients) */
  markUntrusted: z.boolean().default(true),
});

/**
 * Create a personal API token. Sensitive (a token acts as you until it expires), so it needs a fresh
 * password + 2FA confirmation like other sensitive changes. The token is returned once; only its sha256 is stored.
 */
export const POST = route("MEMBER", async ({ session, req }) => {
  const input = await body(req, createSchema);
  await requireStepUp(session);
  const [active] = await db
    .select({ n: count() })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.workspaceId, session.workspaceId),
        eq(apiTokens.userId, session.userId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    );
  if ((active?.n ?? 0) >= MAX_ACTIVE_PER_USER) throw new HttpError(400, "Too many active API tokens", { code: "api_token_limit", max: MAX_ACTIVE_PER_USER });

  const { token, hash, prefix } = generateApiToken();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const [row] = await db
    .insert(apiTokens)
    .values({ workspaceId: session.workspaceId, userId: session.userId, name: input.name, tokenHash: hash, prefix, scopes: ["mcp"], expiresAt, markUntrusted: input.markUntrusted })
    .returning(publicCols);
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "api_token.created",
    targetType: "api_token",
    targetId: row!.id,
    details: { name: input.name, prefix, expiresAt: expiresAt.toISOString(), markUntrusted: input.markUntrusted },
  });
  return { token, apiToken: row, mcpUrl: `${serverEnv.appUrl.replace(/\/+$/, "")}/api/mcp` };
});
