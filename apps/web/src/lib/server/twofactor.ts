import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { consumeRecoveryCode, verifyTotp } from "@wfos/shared/totp";
import { HttpError, type Session } from "./auth";
import { serverEnv } from "./env";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;
const CHALLENGE_COOKIE = "wfos_2fa";
const STEPUP_COOKIE = "wfos_stepup";
const STEPUP_MINUTES = 10;

type User = typeof users.$inferSelect;

function secret() {
  return new TextEncoder().encode(serverEnv.authSecret);
}

function cookieOpts(maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: serverEnv.appUrl.startsWith("https://"), path: "/", maxAge };
}

// ---------------------------------------------------------------------------
// Lockout: 5 failed password or second-factor attempts lock the account for 15 minutes.
// ---------------------------------------------------------------------------

export function lockedError(until: Date): HttpError {
  return new HttpError(423, `Too many failed attempts. Try again at ${until.toISOString()}.`, { code: "account_locked", lockedUntil: until.toISOString() });
}

export function assertNotLocked(user: Pick<User, "lockedUntil">): void {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw lockedError(user.lockedUntil);
}

/** Count a failure atomically; returns the lock expiry when this failure locked the account. */
export async function recordLoginFailure(userId: string): Promise<Date | null> {
  const [r] = await db
    .update(users)
    .set({
      lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${LOCKOUT_THRESHOLD} then now() + make_interval(mins => ${LOCKOUT_MINUTES}) else ${users.lockedUntil} end`,
      failedLoginCount: sql`case when ${users.failedLoginCount} + 1 >= ${LOCKOUT_THRESHOLD} then 0 else ${users.failedLoginCount} + 1 end`,
    })
    .where(eq(users.id, userId))
    .returning({ lockedUntil: users.lockedUntil });
  return r?.lockedUntil && r.lockedUntil.getTime() > Date.now() ? r.lockedUntil : null;
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

/**
 * Check a TOTP code (no replay) or a recovery code (consumed on use). Updates the stored state with a
 * conditional write, so two concurrent requests cannot both use the same code.
 */
export async function verifySecondFactor(user: User, input: { code?: string; recoveryCode?: string }): Promise<"totp" | "recovery" | null> {
  if (!user.totpSecretEnc) return null;
  if (input.code) {
    const counter = verifyTotp(decryptSecret(user.totpSecretEnc), input.code, { lastCounter: user.totpLastCounter });
    if (counter == null) return null;
    const prev = user.totpLastCounter;
    const updated = await db
      .update(users)
      .set({ totpLastCounter: counter })
      .where(and(eq(users.id, user.id), prev == null ? sql`${users.totpLastCounter} is null` : eq(users.totpLastCounter, prev)))
      .returning({ id: users.id });
    return updated.length ? "totp" : null;
  }
  if (input.recoveryCode) {
    const rest = consumeRecoveryCode(user.recoveryCodes, input.recoveryCode);
    if (!rest) return null;
    const updated = await db
      .update(users)
      .set({ recoveryCodes: rest })
      .where(and(eq(users.id, user.id), sql`${users.recoveryCodes} = ${JSON.stringify(user.recoveryCodes)}::jsonb`))
      .returning({ id: users.id });
    return updated.length ? "recovery" : null;
  }
  return null;
}

/** Password (when the account has one) + second factor; failures count toward the lockout. */
export async function reauthenticate(userId: string, input: { password?: string; code?: string; recoveryCode?: string }): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HttpError(401, "Not signed in", { code: "not_signed_in" });
  assertNotLocked(user);
  const passwordOk = !user.passwordHash || (!!input.password && (await bcrypt.compare(input.password, user.passwordHash)));
  const factorOk = passwordOk && (await verifySecondFactor(user, input)) !== null;
  if (!passwordOk || !factorOk) {
    const locked = await recordLoginFailure(user.id);
    if (locked) throw lockedError(locked);
    if (!passwordOk) throw new HttpError(400, "Password is incorrect", { code: "invalid_password" });
    throw new HttpError(400, "The code is not valid", { code: "invalid_code" });
  }
  await clearLoginFailures(user.id);
  return user;
}

// ---------------------------------------------------------------------------
// Login challenge: password accepted, second factor pending (5 minutes, httpOnly cookie)
// ---------------------------------------------------------------------------

export async function setTwoFactorChallenge(userId: string): Promise<void> {
  const token = await new SignJWT({ sub: userId, purpose: "2fa-login" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(secret());
  (await cookies()).set(CHALLENGE_COOKIE, token, cookieOpts(300));
}

export async function readTwoFactorChallenge(): Promise<string | null> {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.purpose === "2fa-login" ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

export async function clearTwoFactorChallenge(): Promise<void> {
  (await cookies()).delete(CHALLENGE_COOKIE);
}

// ---------------------------------------------------------------------------
// Step-up: a fresh password + 2FA check, valid 10 minutes, for sensitive changes
// (e.g. switching an employee to Workspace mode).
// ---------------------------------------------------------------------------

export async function setStepUp(userId: string): Promise<Date> {
  const token = await new SignJWT({ sub: userId, purpose: "step-up" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${STEPUP_MINUTES}m`).sign(secret());
  (await cookies()).set(STEPUP_COOKIE, token, cookieOpts(STEPUP_MINUTES * 60));
  return new Date(Date.now() + STEPUP_MINUTES * 60_000);
}

export async function requireStepUp(session: Session): Promise<void> {
  if (!session.twoFactorEnabled) throw new HttpError(403, "Set up two-factor authentication first", { code: "two_factor_required" });
  const token = (await cookies()).get(STEPUP_COOKIE)?.value;
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      if (payload.purpose === "step-up" && payload.sub === session.userId) return;
    } catch {
      // expired or forged: fall through
    }
  }
  throw new HttpError(401, "Confirm with your password and authenticator code", { code: "step_up_required" });
}
