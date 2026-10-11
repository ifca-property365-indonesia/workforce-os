import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiTokens, db, members, users, workspaces } from "@wfos/db";
import { API_TOKEN_PREFIX, hasRole } from "@wfos/shared";
import { HttpError, type Session } from "./auth";
import { redis } from "./queue";
import { rateLimit } from "./ratelimit";

/** Requests per token per minute on /api/mcp. */
export const API_TOKEN_RATE_PER_MIN = 120;
/** Requests per client IP per minute on /api/mcp, counted before the token is looked up (bounds token guessing). */
export const MCP_IP_RATE_PER_MIN = 300;
/** wait_for_task calls one token may have open at once (each holds a request for up to 60 s). */
export const MCP_WAIT_CONCURRENCY_PER_TOKEN = 3;
/** lastUsedAt is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60_000;
/** Characters of the token kept in clear so the owner can recognise it ("wfos_" + 6). */
const PREFIX_CHARS = API_TOKEN_PREFIX.length + 6;

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh token: shown to its owner once; only the hash and a short prefix are stored. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashApiToken(token), prefix: token.slice(0, PREFIX_CHARS) };
}

/** The token's user with their CURRENT role in the token's workspace. */
export interface ApiTokenSession extends Session {
  /** markUntrusted: tasks and chat messages this token creates start tainted */
  viaToken: { id: string; name: string; markUntrusted: boolean };
}

function invalid(): never {
  // one generic answer for unknown, revoked and expired tokens (no oracle for which one it was)
  throw new HttpError(401, "Invalid or expired API token", { code: "invalid_api_token" });
}

/**
 * `Authorization: Bearer wfos_…` → the token's user in the token's workspace.
 * 401 for a missing/unknown/revoked/expired token or a user who left the workspace, 403 when the account must
 * change its password or enroll 2FA first (as route() does for browser sessions), 429 over the per-token rate limit.
 */
export async function authenticateApiToken(req: Request, scope = "mcp"): Promise<ApiTokenSession> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const presented = m?.[1];
  if (!presented || !presented.startsWith(API_TOKEN_PREFIX) || presented.length > 200) invalid();

  const [tok] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashApiToken(presented)));
  if (!tok || tok.revokedAt || (tok.expiresAt && tok.expiresAt.getTime() <= Date.now()) || !tok.scopes.includes(scope)) invalid();

  const [row] = await db
    .select({
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        mustChangePassword: users.mustChangePassword,
        totpSecretEnc: users.totpSecretEnc,
        passwordChangedAt: users.passwordChangedAt,
      },
      role: members.role,
      workspaceName: workspaces.name,
      require2fa: workspaces.require2faAdmins,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.workspaceId, tok.workspaceId), eq(members.userId, tok.userId)));
  // removed from the workspace: the token stops working, even before anyone revokes it
  if (!row) invalid();
  // a password change (or an admin's reset) ends every session, and every token created before it: whoever had the
  // old password may have minted one. (There is no separate "2FA reset" instant to compare with: disabling 2FA needs
  // the password and a current code, and an admin cannot reset another user's 2FA.)
  if (row.user.passwordChangedAt && tok.createdAt.getTime() < row.user.passwordChangedAt.getTime()) invalid();

  await rateLimit(`apitoken:${tok.id}`, API_TOKEN_RATE_PER_MIN, 60);

  const twoFactorEnabled = !!row.user.totpSecretEnc;
  const session: ApiTokenSession = {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    workspaceId: tok.workspaceId,
    workspaceName: row.workspaceName,
    role: row.role,
    mustChangePassword: row.user.mustChangePassword,
    twoFactorEnabled,
    mustEnroll2fa: !twoFactorEnabled && row.require2fa && hasRole(row.role, "ADMIN"),
    viaToken: { id: tok.id, name: tok.name, markUntrusted: tok.markUntrusted },
  };
  if (session.mustChangePassword) throw new HttpError(403, "Password change required", { code: "password_change_required" });
  if (session.mustEnroll2fa) throw new HttpError(403, "Two-factor authentication must be set up first", { code: "two_factor_enrollment_required" });

  if (!tok.lastUsedAt || Date.now() - tok.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tok.id));
  }
  return session;
}

/** Audit actor label for anything done through a token. */
export function tokenActorLabel(s: ApiTokenSession): string {
  return `api-token:${s.viaToken.name}`;
}

/**
 * Revoke a user's live tokens: in one workspace (removed from it) or everywhere (their password changed).
 * Returns how many were revoked.
 */
export async function revokeUserApiTokens(userId: string, workspaceId?: string): Promise<number> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), workspaceId ? eq(apiTokens.workspaceId, workspaceId) : undefined))
    .returning({ id: apiTokens.id });
  return rows.length;
}

const waitKey = (tokenId: string) => `wfos:mcp:wait:${tokenId}`;

/**
 * Take one of the token's wait_for_task slots, or false when MCP_WAIT_CONCURRENCY_PER_TOKEN are already open.
 * The counter carries a TTL past the longest wait, so a crashed request cannot hold a slot for ever.
 */
export async function acquireWaitSlot(tokenId: string): Promise<boolean> {
  const k = waitKey(tokenId);
  const n = await redis().incr(k);
  await redis().expire(k, 120);
  if (n > MCP_WAIT_CONCURRENCY_PER_TOKEN) {
    await redis().decr(k);
    return false;
  }
  return true;
}

export async function releaseWaitSlot(tokenId: string): Promise<void> {
  await redis().decr(waitKey(tokenId));
}
