import { and, eq, lte, ne, sql } from "drizzle-orm";
import { db, toolOutputs } from "@wfos/db";
import { log } from "./logger";

/**
 * Large tool results (after OpenHuman's handle preview): instead of cutting a result off, the full text is kept in
 * tool_outputs and the model gets a preview (shape, head, outline, tail) plus a handle it can query with read_output.
 */

/** Results longer than this are kept whole and replaced by a preview (the old hard cut was at the same size). */
export const OUTPUT_HANDLE_MIN_CHARS = 8000;
/** What one result may keep (the rest is dropped, and the preview says so). */
export const OUTPUT_STORE_MAX_CHARS = 2_000_000;
/** How long a handle stays readable. */
export const OUTPUT_TTL_MS = 7 * 86_400_000;
/** Cap on one read_output answer. */
export const READ_OUTPUT_MAX_CHARS = 8000;

const HEAD_CHARS = 3000;
const TAIL_CHARS = 800;
const OUTLINE_LINES = 15;
const MAX_MATCHES = 200;
/** a regex is only tried on this much of each line (one huge minified line cannot stall the worker) */
const REGEX_LINE_CHARS = 2000;

export type OutputKind = "json" | "markdown" | "log" | "text";

export interface OutputOwner {
  workspaceId: string;
  employeeId: string;
  taskId: string | null;
  conversationId: string | null;
}

/** The owner of a result produced in a run (structural, so this module does not depend on the tool registry). */
export function outputOwner(ctx: { workspaceId: string; employee: { id: string }; taskId: string | null; conversationId: string | null }): OutputOwner {
  return { workspaceId: ctx.workspaceId, employeeId: ctx.employee.id, taskId: ctx.taskId, conversationId: ctx.conversationId };
}

/** Rough token count of a text (about 4 characters per token). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function tryJson(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const LOG_LINE = /\b(error|warn(ing)?|fail(ed|ure)?|exception|panic|fatal)\b/i;

export function detectKind(text: string): OutputKind {
  if (tryJson(text) !== undefined) return "json";
  const lines = text.split("\n");
  if (lines.filter((l) => /^#{1,6} /.test(l)).length >= 2) return "markdown";
  if (lines.filter((l) => LOG_LINE.test(l)).length >= 3) return "log";
  return "text";
}

function jsonShape(v: unknown): string {
  if (Array.isArray(v)) {
    const first = v.find((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown> | undefined;
    return `array of ${v.length}${first ? ` objects; keys: ${Object.keys(first).slice(0, 12).join(", ")}` : ""}`;
  }
  if (v && typeof v === "object") {
    return `object; keys: ${Object.entries(v as Record<string, unknown>)
      .slice(0, 15)
      .map(([k, x]) => (Array.isArray(x) ? `${k}[${x.length}]` : k))
      .join(", ")}`;
  }
  return typeof v;
}

/** A few lines that show the structure: headings or error lines (JSON shows its keys in the header instead). */
function outline(text: string, kind: OutputKind): string[] {
  const lines = text.split("\n");
  const pick = (re: RegExp) =>
    lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => re.test(l))
      .slice(0, OUTLINE_LINES)
      .map(({ l, i }) => `line ${i + 1}: ${l.trim().slice(0, 160)}`);
  if (kind === "markdown") return pick(/^#{1,6} /);
  if (kind === "log") return pick(LOG_LINE);
  return [];
}

function describe(text: string, kind: OutputKind): string {
  const lines = text.split("\n").length;
  const parts = [`${text.length.toLocaleString("en")} characters`, `${lines.toLocaleString("en")} lines`, `about ${estimateTokens(text.length).toLocaleString("en")} tokens`];
  if (kind === "json") parts.push(`JSON (${jsonShape(tryJson(text))})`);
  else if (kind !== "text") parts.push(`looks like ${kind}`);
  return parts.join(", ");
}

/** The preview the model sees in place of a large result. */
export function buildPreview(tool: string, text: string, handle: string, keptChars: number): string {
  const kind = detectKind(text);
  const both = text.length > HEAD_CHARS + TAIL_CHARS;
  const out = [`[Large result from ${tool}: ${describe(text, kind)}. Showing the start${both ? " and the end" : ""}.]`, text.slice(0, HEAD_CHARS)];
  const ol = outline(text, kind);
  if (ol.length) out.push(`\n[Outline]\n${ol.join("\n")}`);
  if (both) out.push(`\n[… ${(text.length - HEAD_CHARS - TAIL_CHARS).toLocaleString("en")} characters not shown …]\n${text.slice(-TAIL_CHARS)}`);
  out.push(
    `\n[Partial view. The full result is saved as handle ${handle}${keptChars < text.length ? ` (only the first ${keptChars.toLocaleString("en")} characters were kept)` : ""}. ` +
      `Call read_output with this handle to search it (pattern), read lines (from, to) or pick a JSON path (e.g. items[3].email) instead of calling ${tool} again. It stays readable for 7 days.]`,
  );
  return out.join("\n");
}

/**
 * Keep a large result and return the preview to show instead; null when the text is small or it could not be kept
 * (the caller then falls back to cutting it off).
 */
export async function storeToolOutput(owner: OutputOwner, tool: string, text: string, untrusted: boolean): Promise<string | null> {
  if (text.length <= OUTPUT_HANDLE_MIN_CHARS) return null;
  const kept = text.slice(0, OUTPUT_STORE_MAX_CHARS);
  try {
    const id = crypto.randomUUID();
    const preview = buildPreview(tool, text, id, kept.length);
    await db.insert(toolOutputs).values({
      id,
      workspaceId: owner.workspaceId,
      employeeId: owner.employeeId,
      taskId: owner.taskId,
      conversationId: owner.conversationId,
      tool,
      content: kept,
      chars: text.length,
      shownChars: preview.length,
      untrusted,
      expiresAt: new Date(Date.now() + OUTPUT_TTL_MS),
    });
    return preview;
  } catch (e) {
    log.warn({ err: e, tool }, "large tool result not kept; cutting it off instead");
    return null;
  }
}

export interface ReadOutputArgs {
  handle: string;
  pattern?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
  from?: number;
  to?: number;
  path?: string;
}

/** Nested quantifiers like (a+)+ can take exponential time: refused outright. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

function cap(text: string): string {
  return text.length > READ_OUTPUT_MAX_CHARS ? `${text.slice(0, READ_OUTPUT_MAX_CHARS)}\n…[answer cut at ${READ_OUTPUT_MAX_CHARS} characters; narrow the query]` : text;
}

function grep(content: string, a: ReadOutputArgs): string {
  const pattern = a.pattern ?? "";
  const caseSensitive = a.ignoreCase === false;
  let test: (line: string) => boolean;
  if (a.regex) {
    if (pattern.length > 200 || NESTED_QUANTIFIER.test(pattern)) throw new Error("That regular expression is too complex; use a simpler one or a plain-text pattern.");
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    test = (l) => re.test(l.slice(0, REGEX_LINE_CHARS));
  } else {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    test = (l) => (caseSensitive ? l : l.toLowerCase()).includes(needle);
  }
  const lines = content.split("\n");
  const around = Math.min(Math.max(a.context ?? 0, 0), 5);
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (test(lines[i]!)) hits.push(i);
  if (!hits.length) return `No line matches "${pattern}".`;
  const shown = new Set<number>();
  const out: string[] = [];
  let last = -1;
  for (const h of hits.slice(0, MAX_MATCHES)) {
    for (let i = Math.max(0, h - around); i <= Math.min(lines.length - 1, h + around); i++) {
      if (shown.has(i)) continue;
      if (around && last >= 0 && i > last + 1) out.push("--");
      shown.add(i);
      out.push(`${i + 1}${i === h ? ":" : "-"} ${lines[i]!.slice(0, 500)}`);
      last = i;
    }
  }
  return `${hits.length} matching line(s)${hits.length > MAX_MATCHES ? ` (first ${MAX_MATCHES} shown)` : ""}:\n${out.join("\n")}`;
}

function lineRange(content: string, from: number, to: number | undefined): string {
  const lines = content.split("\n");
  const start = Math.max(1, from);
  if (start > lines.length) return `The result has only ${lines.length} lines.`;
  const end = Math.min(lines.length, to ?? start + 199);
  return `Lines ${start}–${end} of ${lines.length}:\n${lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join("\n")}`;
}

/** `items[3].email`, `[0].name`, `data.rows` */
export function parseJsonPath(path: string): (string | number)[] {
  const parts: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) parts.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
  return parts;
}

function jsonAt(content: string, path: string): string {
  const v = tryJson(content);
  if (v === undefined) throw new Error("This result is not JSON; use pattern or from/to instead.");
  let cur: unknown = v;
  for (const p of parseJsonPath(path)) {
    if (cur == null || typeof cur !== "object") throw new Error(`Nothing at "${path}" (stopped at ${String(p)}).`);
    cur = (cur as Record<string | number, unknown>)[p];
  }
  if (cur === undefined) throw new Error(`Nothing at "${path}".`);
  return `${path} (${jsonShape(cur)}):\n${JSON.stringify(cur, null, 2)}`;
}

function summary(row: { tool: string; content: string; chars: number }): string {
  const kind = detectKind(row.content);
  const ol = outline(row.content, kind);
  const kept = row.chars > row.content.length ? ` (the first ${row.content.length.toLocaleString("en")} of ${row.chars.toLocaleString("en")} characters were kept)` : "";
  return [`Result of ${row.tool}: ${describe(row.content, kind)}${kept}.`, ol.length ? `Outline:\n${ol.join("\n")}` : "", `Start:\n${row.content.slice(0, 1500)}`, `End:\n${row.content.slice(-1000)}`]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Answer a read_output call. Only the workspace and employee that produced the result can read it, and only until it
 * expires. Returns the text (capped) and whether the stored result came from an untrusted source.
 */
export async function readToolOutput(owner: Pick<OutputOwner, "workspaceId" | "employeeId">, a: ReadOutputArgs): Promise<{ text: string; untrusted: boolean; tool: string }> {
  const [row] = await db
    .select({ id: toolOutputs.id, tool: toolOutputs.tool, content: toolOutputs.content, chars: toolOutputs.chars, untrusted: toolOutputs.untrusted, expiresAt: toolOutputs.expiresAt })
    .from(toolOutputs)
    .where(and(eq(toolOutputs.id, a.handle), eq(toolOutputs.workspaceId, owner.workspaceId), eq(toolOutputs.employeeId, owner.employeeId)));
  if (!row || !row.content || row.expiresAt.getTime() <= Date.now()) throw new Error("Unknown or expired handle. Run the original tool again if you still need the data.");
  await db
    .update(toolOutputs)
    .set({ reads: sql`${toolOutputs.reads} + 1` })
    .where(eq(toolOutputs.id, row.id))
    .catch((e: unknown) => log.warn({ err: e }, "tool output read not counted"));
  let text: string;
  if (a.pattern) text = grep(row.content, a);
  else if (a.from !== undefined) text = lineRange(row.content, a.from, a.to);
  else if (a.path) text = jsonAt(row.content, a.path);
  else text = summary(row);
  return { text: cap(text), untrusted: row.untrusted, tool: row.tool };
}

/** How long the bookkeeping of a result (size, preview size, reads) stays for the savings figure after it expired. */
export const OUTPUT_STATS_RETENTION_MS = 90 * 86_400_000;

/**
 * Reaper: an expired result loses its content (the row stays for the savings figure); rows past
 * OUTPUT_STATS_RETENTION_MS go entirely. Returns how many rows were emptied or deleted.
 */
export async function pruneToolOutputs(now = new Date()): Promise<number> {
  const emptied = await db
    .update(toolOutputs)
    .set({ content: "" })
    .where(and(lte(toolOutputs.expiresAt, now), ne(toolOutputs.content, "")))
    .returning({ id: toolOutputs.id });
  const deleted = await db
    .delete(toolOutputs)
    .where(lte(toolOutputs.createdAt, new Date(now.getTime() - OUTPUT_STATS_RETENTION_MS)))
    .returning({ id: toolOutputs.id });
  return emptied.length + deleted.length;
}
