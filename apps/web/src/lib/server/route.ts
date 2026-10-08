import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import type { Role } from "@wfos/shared";
import { HttpError, requireSession, type Session } from "./auth";
import { logger } from "./logger";

/** The only API routes usable while a temporary password is still in place. */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/me", "/api/me/password"]);
/** The only API routes usable while a required 2FA enrollment is pending. */
const ENROLL_2FA_ALLOWED = (path: string) => path === "/api/me" || path === "/api/me/2fa" || path.startsWith("/api/me/2fa/");

type Ctx<P> = { session: Session; req: NextRequest; params: P };

/** Route handler wrapper: auth + role check + JSON errors + structured logs. */
export function route<P = Record<string, string>>(minRole: Role, fn: (ctx: Ctx<P>) => Promise<unknown>) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    const started = Date.now();
    try {
      const session = await requireSession(minRole);
      if (session.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.nextUrl.pathname)) {
        throw new HttpError(403, "Password change required", { code: "password_change_required" });
      }
      if (!session.mustChangePassword && session.mustEnroll2fa && !ENROLL_2FA_ALLOWED(req.nextUrl.pathname)) {
        throw new HttpError(403, "Two-factor authentication must be set up first", { code: "two_factor_enrollment_required" });
      }
      const params = (await context.params) as P;
      const out = await fn({ session, req, params });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e, req, started);
    }
  };
}

export function errorResponse(e: unknown, req: NextRequest, started = Date.now()) {
  if (e instanceof HttpError) return NextResponse.json({ ...e.extra, error: e.message }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: "Validation failed", issues: e.issues }, { status: 400 });
  logger.error({ err: (e as Error).message, stack: (e as Error).stack, path: req.nextUrl.pathname, ms: Date.now() - started }, "route error");
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export async function body<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return schema.parse(json);
}

export function notFound(what = "Not found"): never {
  throw new HttpError(404, what);
}

/**
 * Parse a PATCH body: validate with the schema, then keep only keys the client actually sent,
 * so Zod defaults never overwrite stored values.
 */
export async function patchBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<Partial<z.infer<S>>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new HttpError(400, "Body must be an object");
  const parsed = schema.parse(json) as Record<string, unknown>;
  const sent = new Set(Object.keys(json));
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<z.infer<S>>;
}
