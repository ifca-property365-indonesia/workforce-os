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
export function screenLeakage(text: string): GuardFinding[] {
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
