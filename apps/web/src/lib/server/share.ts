import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** the view-only cookie's base name (sent as authCookieName(…)) */
export const VIEW_COOKIE = "wfos_view";
/** how long a link may live (hours) */
export const SHARE_HOURS = [2, 24, 72, 168] as const;

export const newShareToken = () => randomBytes(32).toString("base64url");
export const hashShareToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * What a guest with a view-only link may read: GET only, and only these API paths (an allow-list, so a new route
 * stays closed until it is added here on purpose). Left out on purpose: chat, approvals and their payloads, the
 * outbox, clients and billing, knowledge, memories, settings, audit, secrets, app access/variables/test accounts, the
 * step-by-step activity (tool inputs and outputs). Routes on the list strip what a guest must not read (guestEmployee,
 * the task detail's approvals and messages).
 */
const GUEST_GET: RegExp[] = [
  /^\/api\/me$/,
  /^\/api\/dashboard(\/attention)?$/,
  /^\/api\/office(\/[^/]+)?$/,
  /^\/api\/employees$/,
  /^\/api\/employees\/[^/]+$/,
  /^\/api\/teams$/,
  /^\/api\/teams\/[^/]+$/,
  /^\/api\/tasks$/,
  /^\/api\/tasks\/[^/]+$/,
  /^\/api\/goals$/,
  /^\/api\/apps$/,
  /^\/api\/apps\/[^/]+$/,
  /^\/api\/apps\/[^/]+\/(modules|uptime)$/,
];

export function guestAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  const p = path.replace(/\/+$/, "") || "/";
  return GUEST_GET.some((r) => r.test(p));
}

/** an employee as a guest sees it: who they are and what they do, never their instructions, context or permissions */
export function guestEmployee<E extends Record<string, unknown>>(e: E) {
  const { persona: _p, instructions: _i, businessContext: _b, allowList: _a, egressDomains: _e, toolPermissions: _t, ...rest } = e;
  return rest;
}

/** realtime events a guest receives: work and people, never chat, approvals, mail or money */
const GUEST_EVENTS = /^(task|employee|app|release)\./;
export const guestEventAllowed = (type: unknown) => typeof type === "string" && GUEST_EVENTS.test(type);
