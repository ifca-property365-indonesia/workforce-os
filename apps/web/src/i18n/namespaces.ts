/**
 * Message catalog namespaces: one JSON file per namespace in messages/<locale>/<namespace>.json.
 * The i18n test fails when a file exists that is not listed here (or the other way round).
 */
export const NAMESPACES = [
  "common",
  "status",
  "errors",
  "nav",
  "auth",
  "account",
  "dashboard",
  "employees",
  "hire",
  "tasks",
  "inspector",
  "chat",
  "approvals",
  "teams",
  "clients",
  "routines",
  "knowledge",
  "settings",
  "office",
] as const;
export type Namespace = (typeof NAMESPACES)[number];
