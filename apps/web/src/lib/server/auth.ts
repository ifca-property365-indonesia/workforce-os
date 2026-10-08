import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { db, members, users, workspaces } from "@wfos/db";
import { hasRole, type Role } from "@wfos/shared";
import { serverEnv } from "./env";

export const SESSION_COOKIE = "wfos_session";
const WS_COOKIE = "wfos_ws";

function secret() {
  if (!serverEnv.authSecret || serverEnv.authSecret.length < 32) throw new Error("AUTH_SECRET must be set (>= 32 chars)");
  return new TextEncoder().encode(serverEnv.authSecret);
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("14d").sign(secret());
}

export async function setSession(userId: string, workspaceId?: string) {
  const jar = await cookies();
  const secure = serverEnv.appUrl.startsWith("https://");
  jar.set(SESSION_COOKIE, await createSessionToken(userId), { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 14 * 86400 });
  if (workspaceId) jar.set(WS_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 365 * 86400 });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export interface Session {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  /** OWNER/ADMIN in a workspace that requires 2FA, not enrolled yet: everything else is blocked */
  mustEnroll2fa: boolean;
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let userId: string;
  let issuedAt: number;
  try {
    const { payload } = await jwtVerify(token, secret());
    userId = String(payload.sub);
    issuedAt = Number(payload.iat ?? 0);
  } catch {
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  // a password change revokes every session issued before it
  if (user.passwordChangedAt && issuedAt < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;
  const preferred = jar.get(WS_COOKIE)?.value;
  const rows = await db
    .select({ workspaceId: members.workspaceId, role: members.role, name: workspaces.name, require2fa: workspaces.require2faAdmins })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(eq(members.userId, user.id));
  const m = rows.find((r) => r.workspaceId === preferred) ?? rows[0];
  if (!m) return null;
  const twoFactorEnabled = !!user.totpSecretEnc;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    workspaceId: m.workspaceId,
    workspaceName: m.name,
    role: m.role,
    mustChangePassword: user.mustChangePassword,
    twoFactorEnabled,
    mustEnroll2fa: !twoFactorEnabled && m.require2fa && hasRole(m.role, "ADMIN"),
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** machine-readable error code (the UI translates `errors.<code>`) plus extra fields for the client */
    public extra: { code?: string; [k: string]: unknown } = {},
  ) {
    super(message);
  }
}

export async function requireSession(minRole: Role = "VIEWER"): Promise<Session> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Not signed in", { code: "not_signed_in" });
  if (!hasRole(s.role, minRole)) throw new HttpError(403, `Requires ${minRole} role`, { code: "role_required", role: minRole });
  return s;
}

export async function membership(workspaceId: string, userId: string) {
  const [m] = await db.select().from(members).where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  return m;
}
