/**
 * SKILL.md: YAML frontmatter with `name` and `description`, then a markdown body. Only those two fields are read;
 * anything else in the frontmatter (allowed-tools, license, metadata, …) is ignored and reported, and a skill never
 * carries scripts or resources. The parser handles the YAML a SKILL.md uses: plain, 'single' and "double" quoted
 * scalars, folded (>) and literal (|) block scalars, indented continuation lines and comments. Used on the client
 * (editor preview) and the server (POST /api/skills).
 */

import { hasControlChars, utf8Bytes } from "@wfos/shared";

export type SkillMarkdownError =
  | "no_frontmatter"
  | "unclosed_frontmatter"
  | "frontmatter_too_large"
  | "missing_name"
  | "missing_description"
  | "invalid_chars"
  | "bad_yaml";

/** Largest frontmatter block (UTF-8 bytes between the --- lines): name and description need far less. */
export const SKILL_FRONTMATTER_MAX = 8 * 1024;

export type SkillMarkdownResult =
  | { ok: true; name: string; description: string; body: string; ignoredFields: string[] }
  | { ok: false; error: SkillMarkdownError; line?: number };

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/;
const BLOCK_RE = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/;

function unquoteDouble(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) return null;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/", "0": "\0", " ": " " };
    if (n in simple) out += simple[n];
    else if (n === "u" || n === "x") {
      const len = n === "u" ? 4 : 2;
      const hex = s.slice(i + 1, i + 1 + len);
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += len;
    } else return null;
  }
  return out;
}

/** Whitespace as JavaScript's \s sees it, tested one character at a time (no backtracking anywhere). */
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || (c > "~" && c.trim() === "");

/** Each run of whitespace that spans a line break becomes one space (YAML line folding). Linear. */
function foldLines(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (!isSpace(s[i]!)) {
      out += s[i++];
      continue;
    }
    let j = i;
    let newline = false;
    while (j < s.length && isSpace(s[j]!)) newline = s[j++] === "\n" || newline;
    out += newline ? " " : s.slice(i, j);
    i = j;
  }
  return out;
}

/** The text before a " #" comment (a "#" preceded by whitespace). Linear. */
function stripComment(line: string): string {
  for (let i = 1; i < line.length; i++) if (line[i] === "#" && isSpace(line[i - 1]!)) return line.slice(0, i);
  return line;
}

/** Index of the closing quote of a quoted scalar starting at 0, or -1 ('' and \" do not close it). Linear. */
function closingQuote(v: string): number {
  const q = v[0]!;
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === "\\") i++;
    else if (v[i] === q) {
      if (q === "'" && v[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/**
 * A flow scalar spread over one or more lines: quotes removed, lines folded with spaces. A comment may follow the
 * closing quote. Exported for tests; every step is a single linear scan (the editor parses on every keystroke).
 */
export function flowScalar(raw: string): string | null {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const close = closingQuote(v);
    if (close < 0) return null;
    const after = v.slice(close + 1);
    if (after.trim() && !(isSpace(after[0]!) && after.trim().startsWith("#"))) return null;
    const inner = foldLines(v.slice(1, close));
    return v[0] === '"' ? unquoteDouble(inner) : inner.split("''").join("'");
  }
  // plain scalar: a " #" starts a comment
  return v
    .split("\n")
    .map((l) => stripComment(l).trim())
    .filter(Boolean)
    .join(" ");
}

/** A block scalar (| literal or > folded) from its indented lines; trailing newlines are dropped (values are trimmed). */
function blockScalar(indicator: string, lines: string[]): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Number.POSITIVE_INFINITY);
  const body = lines.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ""));
  let text: string;
  if (indicator.startsWith(">")) {
    // folded: single newlines become spaces, blank lines stay paragraph breaks
    text = "";
    for (let i = 0; i < body.length; i++) {
      const l = body[i]!;
      if (i === 0) text = l;
      else if (l === "" || body[i - 1] === "") text += `\n${l}`;
      else text += ` ${l}`;
    }
  } else text = body.join("\n");
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end--;
  return text.slice(0, end);
}

/** A line that is only spaces and tabs (or empty). */
const blankLine = (l: string): boolean => {
  for (let i = 0; i < l.length; i++) if (l[i] !== " " && l[i] !== "\t") return false;
  return true;
};

/**
 * Parse a SKILL.md. The body is the markdown after the frontmatter, without leading blank lines or trailing space.
 * Linear in the input: no backtracking regex runs over user text, and a frontmatter block over
 * SKILL_FRONTMATTER_MAX bytes is refused before it is read.
 */
export function parseSkillMarkdown(markdown: string): SkillMarkdownResult {
  const lines = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && !lines[start]!.trim()) start++;
  if (lines[start]?.trim() !== "---") return { ok: false, error: "no_frontmatter" };
  let end = start + 1;
  let fmBytes = 0;
  for (; end < lines.length; end++) {
    const l = lines[end]!.trimEnd();
    if (l === "---" || l === "...") break;
    fmBytes += utf8Bytes(lines[end]!) + 1;
    if (fmBytes > SKILL_FRONTMATTER_MAX) return { ok: false, error: "frontmatter_too_large" };
  }
  if (end >= lines.length) return { ok: false, error: "unclosed_frontmatter" };

  const fm = lines.slice(start + 1, end);
  const fields = new Map<string, string>();
  const ignored: string[] = [];
  const indented = (l: string) => l.length > 0 && isSpace(l[0]!);
  for (let i = 0; i < fm.length; ) {
    const line = fm[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (indented(line)) return { ok: false, error: "bad_yaml", line: start + 2 + i };
    const m = KEY_RE.exec(line);
    if (!m) return { ok: false, error: "bad_yaml", line: start + 2 + i };
    const keyLine = start + 2 + i;
    const k = m[1]!;
    const first = (m[2] ?? "").trimEnd();
    // the value's continuation: following lines that are indented (or blank)
    let j = i + 1;
    while (j < fm.length && (!fm[j]!.trim() || indented(fm[j]!))) j++;
    const rest = fm.slice(i + 1, j);
    while (rest.length && !rest[rest.length - 1]!.trim()) rest.pop();
    i = j;
    if (k !== "name" && k !== "description") {
      ignored.push(k);
      continue;
    }
    let value: string | null;
    const block = BLOCK_RE.exec(first);
    if (block) value = blockScalar(block[1]!, rest);
    else value = flowScalar([first, ...rest].join("\n"));
    if (value === null) return { ok: false, error: "bad_yaml", line: keyLine };
    fields.set(k, value);
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!name) return { ok: false, error: "missing_name" };
  if (!description) return { ok: false, error: "missing_description" };
  let bodyStart = end + 1;
  while (bodyStart < lines.length - 1 && blankLine(lines[bodyStart]!)) bodyStart++;
  const body = lines.slice(bodyStart).join("\n").trimEnd();
  if (hasControlChars(name) || hasControlChars(description) || hasControlChars(body)) return { ok: false, error: "invalid_chars" };
  return { ok: true, name, description, body, ignoredFields: [...new Set(ignored)] };
}

/** A SKILL.md for a stored skill (the description double-quoted, so any text survives a round trip). */
export function toSkillMarkdown(s: { slug: string; description: string; body: string }): string {
  return `---\nname: ${s.slug}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`;
}
