import { and, asc, desc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import { db, memories } from "@wfos/db";
import { MEMORY_NEAR_DUPLICATE, MEMORY_TIDY_MAX_SHARE, ROUTING_MODEL } from "@wfos/shared";
import { todayIn } from "@wfos/shared/health";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { redis } from "../lib/redis";
import { memorySnapshot, recordMemoryEvent } from "../lib/memory-journal";
import { embedOne } from "../lib/embeddings";
import { recordStep } from "../lib/steps";
import { oneTurn } from "../runner/one-turn";
import { firstJsonObject } from "../runner/route-classifier";

const TZ = process.env.APP_TIME_ZONE || "Asia/Jakarta";
/** Local hour (APP_TIME_ZONE) of the nightly pass. */
export const MEMORY_TIDY_HOUR = 2;
/** How often index.ts asks whether the nightly pass is due (it runs once per day). */
export const MEMORY_TIDY_CHECK_MS = 10 * 60_000;

type Memory = typeof memories.$inferSelect;

export interface TidyResult {
  expired: number;
  duplicates: number;
  nearDuplicates: number;
  /** lesson memories written from recurring reviewer feedback */
  lessons: number;
}

/** Exact-duplicate key: lower case, whitespace collapsed. */
export function normalizeMemory(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * May `newer` supersede `older`? Only within one client scope; never hide a reviewer's feedback behind a non-feedback
 * memory, and never hide a trusted memory behind an untrusted one (that would let a tainted run's memory push out a trusted one).
 */
function maySupersede(older: Pick<Memory, "kind" | "untrusted" | "clientId">, newer: Pick<Memory, "kind" | "untrusted" | "clientId">): boolean {
  // client isolation: a memory is only ever replaced by one of the same scope (general, or the same client)
  if ((older.clientId ?? null) !== (newer.clientId ?? null)) return false;
  if (older.kind === "feedback" && newer.kind !== "feedback") return false;
  if (!older.untrusted && newer.untrusted) return false;
  return true;
}

/** Best keeper of an exact-duplicate group: feedback first, then trusted, then the newest. */
function keeperRank(a: Memory, b: Memory): number {
  const f = Number(b.kind === "feedback") - Number(a.kind === "feedback");
  if (f) return f;
  const t = Number(a.untrusted) - Number(b.untrusted);
  if (t) return t;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

async function supersede(old: Memory, by: Memory): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [o] = await tx
      .update(memories)
      .set({ supersededBy: by.id, updatedAt: new Date() })
      .where(and(eq(memories.id, old.id), isNull(memories.supersededBy)))
      .returning();
    if (!o) return false;
    await recordMemoryEvent({ workspaceId: old.workspaceId, employeeId: old.employeeId, memoryId: old.id, action: "supersede", actor: "tidy", before: old, after: o }, tx);
    return true;
  });
}

/**
 * Delete expired memories (journaled as "expire" with the full memory as `before`, so it can be restored). Only
 * the expired memory goes: the memories it had superseded are un-superseded (superseded_by cleared, journaled as
 * "update"), so the fact it temporarily replaced is recalled again — the same thing ON DELETE SET NULL would do,
 * but recorded. A memory whose changes do not fit in the budget waits for the next pass.
 */
async function expireMemories(employeeId: string, now: Date, budget: number): Promise<number> {
  const expired = await db
    .select()
    .from(memories)
    .where(and(eq(memories.employeeId, employeeId), lte(memories.expiresAt, now)))
    .orderBy(asc(memories.expiresAt));
  let changes = 0;
  let deleted = 0;
  for (const m of expired) {
    if (changes >= budget) break;
    const below = await db.select().from(memories).where(eq(memories.supersededBy, m.id));
    if (changes + 1 + below.length > budget) continue;
    await db.transaction(async (tx) => {
      for (const b of below) {
        const [after] = await tx.update(memories).set({ supersededBy: null, updatedAt: new Date() }).where(and(eq(memories.id, b.id), eq(memories.supersededBy, m.id))).returning();
        if (after) await recordMemoryEvent({ workspaceId: b.workspaceId, employeeId: b.employeeId, memoryId: b.id, action: "update", actor: "tidy", before: b, after }, tx);
      }
      await recordMemoryEvent({ workspaceId: m.workspaceId, employeeId: m.employeeId, memoryId: m.id, action: "expire", actor: "tidy", before: m, after: null }, tx);
      await tx.delete(memories).where(eq(memories.id, m.id));
    });
    changes += 1 + below.length;
    deleted++;
  }
  return deleted;
}

/** Exact duplicates (normalized content) among live memories: the best one is kept, the others superseded by it. */
async function dedupeExact(live: Memory[], budget: number, changed: Set<string>): Promise<number> {
  const groups = new Map<string, Memory[]>();
  for (const m of live) {
    // per client scope: duplicates are only merged within general memories or within one client's
    const k = `${m.clientId ?? ""}\u0000${normalizeMemory(m.content)}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  let changes = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keeper, ...rest] = [...group].sort(keeperRank);
    for (const old of rest) {
      if (changes >= budget) return changes;
      if (!maySupersede(old, keeper!)) continue;
      if (await supersede(old, keeper!)) {
        changed.add(old.id);
        changes++;
      }
    }
  }
  return changes;
}

/** Word tokens for the lexical check: lower case, letters and digits only. */
function tokens(content: string): Set<string> {
  return new Set(content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Numbers, and capitalised words that do not start a sentence (names, places, products): they must match exactly. */
function specifics(content: string): Set<string> {
  const out = new Set<string>(content.match(/\d+(?:[.,]\d+)*/g) ?? []);
  for (const sentence of content.split(/[.!?;:\n]+/)) {
    const words = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
    for (const w of words.slice(1)) if (/^\p{Lu}/u.test(w)) out.add(w);
  }
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Jaccard similarity of the word tokens at or above this (and the same specifics) makes two memories lexically alike. */
export const MEMORY_NEAR_DUPLICATE_JACCARD = 0.8;

/**
 * The lexical half of the near-duplicate test: embeddings put "Client X pays 10M" next to "Client Y pays 20M", so a
 * close vector alone must not hide a memory. Token Jaccard ≥ MEMORY_NEAR_DUPLICATE_JACCARD and identical sets of
 * numbers and capitalised words.
 */
export function lexicallyNear(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = ta.size + tb.size - inter;
  if (!union || inter / union < MEMORY_NEAR_DUPLICATE_JACCARD) return false;
  return sameSet(specifics(a), specifics(b));
}

/** Neighbours looked at per memory (an exact scan over the employee's memories: there is no vector index). */
const NEAR_NEIGHBOURS = 5;

/**
 * Near-duplicates among live memories: cosine similarity > MEMORY_NEAR_DUPLICATE AND lexically alike (lexicallyNear).
 * The older one is superseded by the newer. Per memory (oldest first), its NEAR_NEIGHBOURS nearest live memories of
 * the same employee are looked at; the most similar newer one that passes replaces it.
 */
async function dedupeNear(now: Date, live: Memory[], budget: number, changed: Set<string>): Promise<number> {
  if (budget <= 0) return 0;
  const byId = new Map(live.map((m) => [m.id, m]));
  const candidates = live.filter((m) => m.embedding).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const newerThan = (b: Memory, a: Memory) => b.createdAt.getTime() > a.createdAt.getTime() || (b.createdAt.getTime() === a.createdAt.getTime() && b.id > a.id);
  let changes = 0;
  for (const older of candidates) {
    if (changes >= budget) break;
    if (changed.has(older.id)) continue;
    const near = await db.execute<{ id: string; sim: number }>(sql`
      SELECT b.id, 1 - (b.embedding <=> a.embedding) AS sim
      FROM memories a
      JOIN memories b ON b.employee_id = a.employee_id AND b.id <> a.id
      WHERE a.id = ${older.id}
        AND b.superseded_by IS NULL AND b.embedding IS NOT NULL
        AND (b.expires_at IS NULL OR b.expires_at > ${now.toISOString()}::timestamptz)
      ORDER BY b.embedding <=> a.embedding
      LIMIT ${NEAR_NEIGHBOURS}`);
    for (const n of near) {
      if (Number(n.sim) <= MEMORY_NEAR_DUPLICATE) break; // nearest first
      // a memory superseded in this pass never becomes the replacement of another
      if (changed.has(n.id)) continue;
      const newer = byId.get(n.id);
      if (!newer || !newerThan(newer, older) || !maySupersede(older, newer) || !lexicallyNear(older.content, newer.content)) continue;
      if (await supersede(older, newer)) {
        changed.add(older.id);
        changes++;
      }
      break;
    }
  }
  return changes;
}

/**
 * One tidy pass over an employee's memories: expire, then exact duplicates, then near-duplicates. At most
 * ceil(MEMORY_TIDY_MAX_SHARE × number of memories) changes per pass; every change is journaled (actor "tidy").
 */
export async function tidyEmployeeMemories(employeeId: string, now: Date = new Date()): Promise<TidyResult> {
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(memories).where(eq(memories.employeeId, employeeId));
  const budget = Math.ceil(MEMORY_TIDY_MAX_SHARE * n);
  const result: TidyResult = { expired: 0, duplicates: 0, nearDuplicates: 0, lessons: 0 };
  if (!budget) return result;
  result.expired = await expireMemories(employeeId, now, budget);
  let left = budget - result.expired;
  if (left <= 0) return result;
  const live = await db
    .select()
    .from(memories)
    .where(and(eq(memories.employeeId, employeeId), isNull(memories.supersededBy), or(isNull(memories.expiresAt), gt(memories.expiresAt, now))));
  const changed = new Set<string>();
  result.duplicates = await dedupeExact(live, left, changed);
  left -= result.duplicates;
  result.nearDuplicates = await dedupeNear(now, live, left, changed);
  return result;
}

// ---------------------------------------------------------------------------
// Lessons (after OpenHuman's beliefs): recurring reviewer feedback summed up as a few lasting rules
// ---------------------------------------------------------------------------

/** trusted general feedback it takes before lessons are written, how far back it counts, and how often per employee */
export const LESSON_MIN_FEEDBACK = 4;
export const LESSON_WINDOW_DAYS = 60;
export const LESSON_EVERY_DAYS = 7;
export const LESSONS_MAX = 3;
const LESSON_TIMEOUT_MS = 30_000;

const LESSON_PROMPT = [
  "You help an AI employee learn from its human reviewers.",
  "You get the reviewers' feedback (between <feedback> tags) and the lessons the employee already has.",
  `Write at most ${LESSONS_MAX} short, lasting rules that follow from feedback given at least twice. Each rule: one sentence, imperative, at most 200 characters, in the language of the feedback.`,
  "Do not repeat an existing lesson. If nothing recurs, return an empty list.",
  'Answer with one JSON object and nothing else: {"lessons":["..."]}.',
].join("\n");

export function parseLessons(text: string): string[] {
  const o = firstJsonObject(text) as { lessons?: unknown } | null;
  if (!o || !Array.isArray(o.lessons)) return [];
  return o.lessons
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 10 && l.length <= 300)
    .slice(0, LESSONS_MAX);
}

/**
 * When an employee got at least LESSON_MIN_FEEDBACK pieces of trusted, general reviewer feedback in the last
 * LESSON_WINDOW_DAYS and has no lesson younger than LESSON_EVERY_DAYS, one fast-model turn sums the recurring ones up
 * as "lesson" memories (recalled on every run, before the feedback). Journaled like any change by tidy; the credits go
 * on the employee's Activity. Never throws.
 */
export async function writeLessons(workspaceId: string, employeeId: string, now: Date = new Date()): Promise<number> {
  try {
    const live = and(eq(memories.employeeId, employeeId), isNull(memories.supersededBy), or(isNull(memories.expiresAt), gt(memories.expiresAt, now)), isNull(memories.clientId));
    const lessons = await db.select().from(memories).where(and(live, eq(memories.kind, "lesson"))).orderBy(desc(memories.createdAt));
    if (lessons[0] && now.getTime() - lessons[0].createdAt.getTime() < LESSON_EVERY_DAYS * 86_400_000) return 0;
    const feedback = await db
      .select({ content: memories.content })
      .from(memories)
      .where(and(live, eq(memories.kind, "feedback"), eq(memories.untrusted, false), gte(memories.createdAt, new Date(now.getTime() - LESSON_WINDOW_DAYS * 86_400_000))))
      .orderBy(desc(memories.createdAt))
      .limit(30);
    if (feedback.length < LESSON_MIN_FEEDBACK) return 0;
    const r = await oneTurn({
      workspaceId,
      model: ROUTING_MODEL,
      systemPrompt: LESSON_PROMPT,
      prompt: [`<feedback>\n${feedback.map((f) => `- ${f.content.slice(0, 500)}`).join("\n")}\n</feedback>`, `<existing_lessons>\n${lessons.map((l) => `- ${l.content}`).join("\n") || "(none)"}\n</existing_lessons>`].join("\n\n"),
      timeoutMs: LESSON_TIMEOUT_MS,
      label: "lessons",
    });
    await recordStep({ workspaceId, employeeId, kind: "system", name: "memory_lessons", model: r.model, ...r.usage, latencyMs: r.latencyMs, credits: r.credits, status: r.failure ?? "ok" }).catch(() => {});
    const fresh = parseLessons(r.text).filter((l) => !lessons.some((x) => lexicallyNear(x.content, l)));
    for (const content of fresh) {
      const embedding = await embedOne(content).catch(() => null);
      const [m] = await db.insert(memories).values({ workspaceId, employeeId, kind: "lesson", source: "tidy", content, embedding }).returning();
      await recordMemoryEvent({ workspaceId, employeeId, memoryId: m!.id, action: "create", actor: "tidy", before: null, after: memorySnapshot(m!) }).catch((e: unknown) =>
        log.warn({ err: e }, "memory journal failed for a lesson"),
      );
    }
    return fresh.length;
  } catch (e) {
    log.warn({ err: e, employeeId }, "lessons not written");
    return 0;
  }
}

/** The pass over every employee that has memories. */
export async function tidyAllMemories(now: Date = new Date()): Promise<TidyResult> {
  const emps = await db.selectDistinct({ id: memories.employeeId, workspaceId: memories.workspaceId }).from(memories);
  const total: TidyResult = { expired: 0, duplicates: 0, nearDuplicates: 0, lessons: 0 };
  for (const { id, workspaceId } of emps) {
    try {
      const r = await tidyEmployeeMemories(id, now);
      total.expired += r.expired;
      total.duplicates += r.duplicates;
      total.nearDuplicates += r.nearDuplicates;
    } catch (e) {
      log.warn({ err: e, employeeId: id }, "memory tidy failed for an employee");
    }
    total.lessons += await writeLessons(workspaceId, id, now);
  }
  return total;
}

/**
 * Called every MEMORY_TIDY_CHECK_MS: runs the pass in the MEMORY_TIDY_HOUR hour (APP_TIME_ZONE), once per day
 * (a Redis key claims the day, so several workers or a restart do not repeat it). Returns null when not due.
 */
export async function memoryTidyTick(now: Date = new Date()): Promise<TidyResult | null> {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour !== MEMORY_TIDY_HOUR) return null;
  const claimed = await redis.set(`${env.namespace}:memory-tidy:${todayIn(TZ, now)}`, "1", "EX", 2 * 86_400, "NX");
  if (!claimed) return null;
  const r = await tidyAllMemories(now);
  log.info(r, "nightly memory tidy");
  return r;
}
