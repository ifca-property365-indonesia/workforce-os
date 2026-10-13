import { eq } from "drizzle-orm";
import { appReleases, db } from "@wfos/db";
import { redactSecrets } from "@wfos/shared/server";
import { log } from "../lib/logger";

/** A release log keeps at most this much text (the tail; the head is cut at a line break). */
export const RELEASE_LOG_MAX = 200 * 1024;
/** Values shorter than this are not replaced literally (a "1" or "true" would shred the log; they are no secrets). */
const MIN_SECRET_LEN = 4;
/** Longest value a secret can have (env values are capped at 4000 characters). */
const MAX_SECRET_LEN = 4096;

/**
 * Removes this app's secrets from any text that leaves the pipeline (log, release error, audit, notification): every
 * env value, the APP_SECRET, the database password and URL, the preview password and the repository token, replaced
 * literally (longest first), then the shared high-severity patterns (redactSecrets).
 */
export class Redactor {
  private secrets: string[] = [];

  add(...values: (string | null | undefined)[]): void {
    for (const v of values) {
      if (!v || v.length < MIN_SECRET_LEN || this.secrets.includes(v)) continue;
      this.secrets.push(v);
      // also the forms a URL or a shell would print it in
      const enc = encodeURIComponent(v);
      if (enc !== v && !this.secrets.includes(enc)) this.secrets.push(enc);
    }
    this.secrets.sort((a, b) => b.length - a.length);
  }

  apply(text: string): string {
    let t = text;
    for (const s of this.secrets) if (t.includes(s)) t = t.split(s).join("[REDACTED]");
    return redactSecrets(t);
  }
}

/**
 * The text from `from` on, starting after a line break. Secrets never contain one, so a value cut in half at `from`
 * is dropped whole; without a break within the longest secret's length, that much more is dropped.
 */
function tailFrom(text: string, from: number): string {
  if (from <= 0) return text;
  const nl = text.indexOf("\n", from);
  const start = nl >= 0 && nl - from <= MAX_SECRET_LEN ? nl + 1 : from + MAX_SECRET_LEN;
  return text.slice(start);
}

/**
 * The log of one release: raw output is kept in memory (bounded), and what is stored is always the redacted text,
 * capped at RELEASE_LOG_MAX keeping the tail. Redaction runs over the whole buffer at each flush, so a secret split
 * across two output chunks is still found. Writes reach the database at most every `flushEveryMs` (and on flush()).
 */
export class ReleaseLog {
  private raw = "";
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly releaseId: string,
    private readonly redactor: Redactor,
    private readonly flushEveryMs = 2000,
    initial = "",
  ) {
    this.raw = initial;
  }

  write(chunk: string): void {
    if (!chunk || this.closed) return;
    this.raw += chunk;
    if (this.raw.length > 2 * RELEASE_LOG_MAX) this.raw = tailFrom(this.raw, this.raw.length - Math.floor(1.5 * RELEASE_LOG_MAX));
    if (!this.timer) this.timer = setTimeout(() => void this.flush().catch((e) => log.warn({ err: e, releaseId: this.releaseId }, "release log flush failed")), this.flushEveryMs);
  }

  /** One line of the platform's own (on a line of its own, also after output that did not end with one). */
  line(text: string): void {
    this.write(`${this.raw && !this.raw.endsWith("\n") ? "\n" : ""}${text}\n`);
  }

  /**
   * The stored form: redacted, capped. Until `final`, the end of an unfinished output line is held back (up to the
   * longest secret's length): a secret still arriving could not be matched yet, and its first half must not show.
   */
  text(final = false): string {
    let red = this.redactor.apply(this.raw);
    if (!final && !red.endsWith("\n")) {
      const lineStart = red.lastIndexOf("\n") + 1;
      red = red.slice(0, Math.max(lineStart, red.length - MAX_SECRET_LEN));
    }
    if (red.length <= RELEASE_LOG_MAX) return red;
    return `[… earlier output cut …]\n${tailFrom(red, red.length - RELEASE_LOG_MAX + 64)}`;
  }

  async flush(final = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await db.update(appReleases).set({ log: this.text(final) }).where(eq(appReleases.id, this.releaseId));
  }

  /** Last flush (everything); nothing is written afterwards. */
  async close(): Promise<void> {
    await this.flush(true);
    this.closed = true;
  }
}
