import { matchToolPermission, normalizeMcpName, type AutonomyLevel, type ToolPermission } from "@wfos/shared";

/** Characters allowed in an MCP tool selector typed by hand (`list_*`, `crm.delete*`). */
const SELECTOR_RE = /^[A-Za-z0-9_*.-]+$/;
export const MAX_SELECTOR_LENGTH = 128;
/** The shared permission schema refuses selectors with more wildcards than this. */
export const MAX_SELECTOR_STARS = 8;

/**
 * Normalise and validate a hand-typed tool selector for `mcp:<server>:<selector>`.
 * Returns the selector as the gate compares it (lower-case, [^a-z0-9_*-] → "_"), or null when it is empty, too
 * long, uses other characters, has too many "*", or is only `*` (use the server-level toggle for "every tool").
 */
export function parseToolSelector(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > MAX_SELECTOR_LENGTH || !SELECTOR_RE.test(s)) return null;
  if (/^\*+$/.test(s)) return null;
  if ((s.match(/\*/g)?.length ?? 0) > MAX_SELECTOR_STARS) return null;
  return normalizeMcpName(s, true);
}

/**
 * Permission key for one tool (or glob) of an external MCP server, always in normalised form: the name the
 * Claude SDK exposes (`Contacts.Delete` → `contacts_delete`), "*" kept so globs stay globs.
 */
export function mcpToolKey(server: string, selector: string): string {
  return `mcp:${server}:${normalizeMcpName(selector, true)}`;
}

/** A saved permission key in normalised form: `mcp:<server>:<selector>` gets its selector normalised, anything else is returned as is. */
export function normalizePermissionKey(tool: string): string {
  const m = /^mcp:([^:]+):(.+)$/.exec(tool);
  return m ? mcpToolKey(m[1]!, m[2]!) : tool;
}

/** `mcp:<server>:…` entries of `perms` (per-tool rules and globs, not the server-level grant). */
export function mcpToolRules(perms: ToolPermission[], server: string): ToolPermission[] {
  const prefix = `mcp:${server}:`;
  return perms.filter((p) => p.tool.startsWith(prefix));
}

/**
 * How a single MCP tool resolves under `perms`: enabled or not, the rule that disabled it when that is not the
 * tool's own rule (a glob or the server grant), and the autonomy it inherits when it has no rule of its own.
 * `tool` may be the raw or the normalised name; a rule saved with the raw name counts as the tool's own rule.
 */
export function resolveMcpTool(perms: ToolPermission[], server: string, tool: string) {
  const key = mcpToolKey(server, tool);
  const isOwn = (p: ToolPermission) => normalizePermissionKey(p.tool) === key;
  const own = perms.find(isOwn);
  const effective = matchToolPermission(key, perms);
  const others = perms.filter((p) => !isOwn(p));
  const inherited = matchToolPermission(key, others);
  const blockedBy = others.find((p) => !p.enabled && p.tool !== `mcp:${server}` && matchToolPermission(key, [p]));
  return {
    key,
    own,
    enabled: !!effective?.enabled,
    blockedBy: blockedBy ? normalizePermissionKey(blockedBy.tool) : undefined,
    inheritedAutonomy: inherited?.enabled ? inherited.autonomy : undefined,
  };
}

/**
 * Set (or with `null`, remove) the permission entry for `key`, keeping every other entry as is. Entries whose
 * normalised key equals `key` (a rule saved with a raw MCP tool name) are replaced too, so they migrate to the
 * normalised form instead of lingering as duplicates.
 */
export function upsertPermission(perms: ToolPermission[], key: string, next: ToolPermission | null): ToolPermission[] {
  const norm = normalizePermissionKey(key);
  const same = (p: ToolPermission) => normalizePermissionKey(p.tool) === norm;
  if (!next) return perms.filter((p) => !same(p));
  const i = perms.findIndex(same);
  if (i === -1) return [...perms, next];
  return perms.flatMap((p, j) => (j === i ? [next] : same(p) ? [] : [p]));
}

/**
 * Switch one listed MCP tool on or off. Off saves `{ enabled: false }` under the normalised key; on drops the
 * tool's own rule (it follows the server grant again) unless it has its own autonomy, which is kept. `remembered`
 * is an autonomy the editor saw on this tool earlier (switching off does not keep it in the saved rule).
 */
export function toggleMcpTool(perms: ToolPermission[], server: string, tool: string, on: boolean, remembered?: AutonomyLevel): ToolPermission[] {
  const r = resolveMcpTool(perms, server, tool);
  if (!on) return upsertPermission(perms, r.key, { tool: r.key, enabled: false });
  const autonomy = r.own?.autonomy ?? remembered;
  return upsertPermission(perms, r.key, autonomy ? { tool: r.key, enabled: true, autonomy } : null);
}

/** Give one listed MCP tool its own autonomy, or with `undefined` drop its rule so it inherits again. */
export function setMcpToolAutonomy(perms: ToolPermission[], server: string, tool: string, level: AutonomyLevel | undefined): ToolPermission[] {
  const key = mcpToolKey(server, tool);
  return upsertPermission(perms, key, level ? { tool: key, enabled: true, autonomy: level } : null);
}
