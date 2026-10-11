import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// AES-256-GCM secret box. Ciphertext format: v1:<iv b64>:<tag b64>:<data b64>
// ---------------------------------------------------------------------------

function parseKey(raw: string, name: string): Buffer {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex chars or base64)`);
  return buf;
}

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  return parseKey(raw, "ENCRYPTION_KEY");
}

/** During a key rotation the old key still decrypts (never encrypts) until `cli rotate-key` re-encrypted everything. */
function previousKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY_PREVIOUS;
  return raw ? parseKey(raw, "ENCRYPTION_KEY_PREVIOUS") : null;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

function openBox(box: string, k: Buffer): string {
  const [v, iv, tag, data] = box.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Malformed secret box");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function decryptSecret(box: string): string {
  try {
    return openBox(box, key());
  } catch (e) {
    const prev = previousKey();
    if (!prev || (e as Error).message === "Malformed secret box") throw e;
    return openBox(box, prev);
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Guards (pure functions; enabled by default per workspace)
// ---------------------------------------------------------------------------

export interface GuardFinding {
  rule: string;
  severity: "low" | "medium" | "high";
  excerpt: string;
}

const INJECTION_PATTERNS: { rule: string; re: RegExp; severity: GuardFinding["severity"] }[] = [
  { rule: "ignore-instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?)/i, severity: "high" },
  { rule: "role-override", re: /\b(you are now|act as|pretend to be|new instructions?:|system prompt:)/i, severity: "medium" },
  { rule: "exfiltration", re: /\b(send|email|post|upload|forward)\b[^.\n]{0,60}\b(api[_ -]?key|password|secret|token|credentials?)\b/i, severity: "high" },
  { rule: "hidden-tool-call", re: /<\s*(tool_use|function_calls?|invoke)\b/i, severity: "high" },
  { rule: "approval-bypass", re: /\b(without|skip|bypass)\b[^.\n]{0,30}\b(approval|confirmation|review)\b/i, severity: "medium" },
];

/** Screen untrusted tool results (web pages, documents, other agents) for prompt injection. */
export function screenInjection(text: string): GuardFinding[] {
  const out: GuardFinding[] = [];
  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text);
    if (m) out.push({ rule: p.rule, severity: p.severity, excerpt: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) });
  }
  return out;
}

const LEAK_PATTERNS: { rule: string; re: RegExp; severity: GuardFinding["severity"] }[] = [
  { rule: "anthropic-key", re: /sk-ant-[a-z0-9]{2,}-[A-Za-z0-9_\-]{20,}/g, severity: "high" },
  { rule: "openai-style-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g, severity: "high" },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, severity: "high" },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, severity: "high" },
  { rule: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, severity: "high" },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, severity: "high" },
  { rule: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, severity: "high" },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: "high" },
  // bounded scheme and userinfo so long word-boundary runs cannot make this quadratic
  { rule: "url-credentials", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{0,256}:[^\s/@]{1,256}@/gi, severity: "high" },
  { rule: "wfos-token", re: /\b(?:wfos|whsec)_[A-Za-z0-9_-]{30,}/g, severity: "high" },
  { rule: "telegram-bot-token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, severity: "high" },
  { rule: "vendor-token", re: /\b(?:SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,})\b/g, severity: "high" },
  { rule: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, severity: "high" },
  {
    rule: "secret-assignment",
    re: /["']?\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|token)["']?\s*[:=]\s*["']?(?!process\.env\b|os\.environ\b|env\.|\$\{|\$[A-Z_])[A-Za-z0-9_\-./+]{12,}/gi,
    severity: "medium",
  },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: "medium" },
  { rule: "password-assignment", re: /\b(password|passwd|pwd)\s*[:=]\s*\S{6,}/gi, severity: "high" },
  { rule: "credit-card", re: /\b(?:\d[ -]?){13,16}\b/g, severity: "medium" },
  { rule: "nik-indonesia", re: /\b\d{16}\b/g, severity: "medium" },
];

function luhn(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 13) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Check outputs for secrets / PII before they are shown or leave the system. */
/** Longest text the leak patterns scan in one call (longer payloads are scanned in their first 200 000 chars). */
export const LEAK_SCAN_MAX_CHARS = 200_000;

export function screenLeakage(input: string): GuardFinding[] {
  const text = input.length > LEAK_SCAN_MAX_CHARS ? input.slice(0, LEAK_SCAN_MAX_CHARS) : input;
  const out: GuardFinding[] = [];
  for (const p of LEAK_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      if (p.rule === "credit-card" && !luhn(m[0])) continue;
      out.push({ rule: p.rule, severity: p.severity, excerpt: redact(m[0]) });
      if (out.length > 20) return out;
    }
  }
  return out;
}

function redact(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

/** Redact high-severity secrets in text (used for logs / UI). */
export function redactSecrets(text: string): string {
  let t = text;
  for (const p of LEAK_PATTERNS) {
    if (p.severity !== "high") continue;
    p.re.lastIndex = 0;
    t = t.replace(p.re, (m) => `[REDACTED:${p.rule}:${redact(m)}]`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Export redaction (team / employee packages): everything that could be a secret leaves as a marker
// ---------------------------------------------------------------------------

/** A path segment or host label that reads like a key or token rather than a word. */
function looksLikeKey(part: string): boolean {
  if (/[A-Za-z0-9]{24,}/.test(part)) return true;
  // a single letters-only run of 16+ (abcdefghijklmnopqrst) or 4+ equal-length dash groups (AB12-CD34-EF56-GH78)
  if (/^[A-Za-z]{16,}$/.test(part) && !/^[a-z]+$/.test(part.replace(/[A-Z]/, (c) => c.toLowerCase()))) return true;
  if (/^[A-Za-z]{20,}$/.test(part)) return true;
  const groups = part.split("-");
  if (groups.length >= 4 && groups.every((g) => g.length === groups[0]!.length && /^[A-Za-z0-9]{3,8}$/.test(g))) return true;
  // hyphenated words with short numbers (github-mcp-server-2024, v2, s3) are names, not keys
  const tokens = part.split(/[-_.~]+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^[A-Za-z]+$/.test(t) || /^\d{1,8}$/.test(t) || t.length <= 6)) return false;
  return part.length >= 16 && /[A-Za-z]/.test(part) && /\d/.test(part);
}

/**
 * A URL safe to share: userinfo and #fragment dropped, every query value emptied (names kept), and path
 * segments / subdomain labels that look like keys replaced by "redacted". Pushes the rules it applied to `found`.
 * An unparseable URL becomes "".
 */
export function redactUrl(raw: string, found: string[] = []): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    found.push("url-invalid");
    return "";
  }
  const rules = new Set<string>();
  if (u.username || u.password) rules.add("url-userinfo");
  if (u.hash) rules.add("url-fragment");
  const params = [...u.searchParams.entries()];
  if (params.some(([, v]) => v !== "")) rules.add("url-query");
  const search = params.map(([k]) => `${encodeURIComponent(k)}=`).join("&");
  const labels = u.hostname.split(".");
  // the last two labels are the registrable domain: only subdomain labels can carry a token
  const host = labels.map((l, i) => (i < labels.length - 2 && looksLikeKey(l) ? (rules.add("url-key"), "redacted") : l)).join(".");
  const path = u.pathname
    .split("/")
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // malformed escape: check the raw segment
      }
      return seg && looksLikeKey(decoded) ? (rules.add("url-key"), "redacted") : seg;
    })
    .join("/");
  found.push(...rules);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${path}${search ? `?${search}` : ""}`;
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;

/**
 * Redact text for export. Like screenLeakage + redactSecrets, but every finding is replaced (high and medium:
 * keys, JWTs, card numbers, NIK, passwords) by `[REDACTED:<rule>]` with no excerpt, and URLs in the text go
 * through redactUrl. Returns the rules that fired.
 */
export function exportRedact(text: string): { text: string; rules: string[] } {
  const rules = new Set<string>();
  let t = text;
  for (const p of LEAK_PATTERNS) {
    p.re.lastIndex = 0;
    t = t.replace(p.re, (m) => {
      if (p.rule === "credit-card" && !luhn(m)) return m;
      rules.add(p.rule);
      return `[REDACTED:${p.rule}]`;
    });
  }
  t = t.replace(URL_IN_TEXT_RE, (m) => {
    const found: string[] = [];
    const safe = redactUrl(m, found);
    if (!found.length) return m;
    for (const r of found) rules.add(r);
    return safe || "[REDACTED:url]";
  });
  // belt and braces: nothing the leakage screen still finds may leave
  for (const f of screenLeakage(t)) rules.add(f.rule);
  return { text: rules.size ? redactSecrets(t) : t, rules: [...rules] };
}

// ---------------------------------------------------------------------------
// Retry with timeout for every external call
// ---------------------------------------------------------------------------

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { retries?: number; timeoutMs?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const base = opts.baseDelayMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`${opts.label ?? "call"} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      lastErr = err;
      if ((err as { noRetry?: boolean })?.noRetry) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, base * 2 ** attempt + Math.random() * 100));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
