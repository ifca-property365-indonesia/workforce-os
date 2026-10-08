import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import type { Role } from "@wfos/shared";
import { HttpError, requireSession, type Session } from "./auth";
import { logger } from "./logger";
import { serverT } from "./i18n";
import { createFormatter } from "@/lib/format";
import { APP_TIME_ZONE } from "@/i18n/locale";

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

/** JSON error in the requesting user's language: errors.<code> from the catalog, with the extra fields as values. */
export async function errorResponse(e: unknown, req: NextRequest, started = Date.now()) {
  const { t, locale } = await serverT().catch(() => ({ t: null, locale: "en" as const }));
  if (e instanceof HttpError) {
    const { code, ...values } = e.extra;
    let message = e.message;
    if (t && code && t.has(`errors.${code}`)) {
      const v: Record<string, string | number> = {};
      for (const [k, x] of Object.entries(values)) if (typeof x === "string" || typeof x === "number") v[k] = x;
      if (typeof values.lockedUntil === "string") v.time = createFormatter(locale, APP_TIME_ZONE).time(values.lockedUntil);
      if (typeof values.status === "string" && t.has(`status.any.${values.status}`)) v.status = t(`status.any.${values.status}`);
      message = t(`errors.${code}`, v);
    }
    return NextResponse.json({ ...e.extra, error: message }, { status: e.status });
  }
  if (e instanceof ZodError) {
    const fields = [...new Set(e.issues.map((i) => i.path.join(".") || "body"))].join(", ");
    return NextResponse.json({ error: t ? t("errors.validation", { fields }) : `Invalid input: ${fields}`, code: "validation", issues: e.issues }, { status: 400 });
  }
  logger.error({ err: (e as Error).message, stack: (e as Error).stack, path: req.nextUrl.pathname, ms: Date.now() - started }, "route error");
  return NextResponse.json({ error: t ? t("errors.internal") : "Internal error", code: "internal" }, { status: 500 });
}

export async function body<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body", { code: "invalid_json" });
  }
  return schema.parse(json);
}

export function notFound(code = "not_found"): never {
  // i18n-ignore: codes are checked where notFound() is called
  throw new HttpError(404, "Not found", { code });
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
    throw new HttpError(400, "Invalid JSON body", { code: "invalid_json" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new HttpError(400, "Body must be an object", { code: "invalid_json" });
  const parsed = schema.parse(json) as Record<string, unknown>;
  const sent = new Set(Object.keys(json));
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<z.infer<S>>;
}
