import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db, memories } from "@wfos/db";
import { MEMORY_NEAR_DUPLICATE, MEMORY_TIDY_MAX_SHARE } from "@wfos/shared";
import { todayIn } from "@wfos/shared/health";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { redis } from "../lib/redis";
import { recordMemoryEvent } from "../lib/memory-journal";

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
}

/** Exact-duplicate key: lower case, whitespace collapsed. */
export function normalizeMemory(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * May `newer` supersede `older`? Never hide a reviewer's feedback behind a non-feedback memory, and never hide
 * a trusted memory behind an untrusted one (that would let a tainted run's memory push out a trusted one).
 */
function maySupersede(older: Pick<Memory, "kind" | "untrusted">, newer: Pick<Memory, "kind" | "untrusted">): boolean {
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
    const k = normalizeMemory(m.content);
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
async function dedupeNear(employeeId: string, now: Date, live: Memory[], budget: number, changed: Set<string>): Promise<number> {
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
  const result: TidyResult = { expired: 0, duplicates: 0, nearDuplicates: 0 };
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
  result.nearDuplicates = await dedupeNear(employeeId, now, live, left, changed);
  return result;
}

/** The pass over every employee that has memories. */
export async function tidyAllMemories(now: Date = new Date()): Promise<TidyResult> {
  const emps = await db.selectDistinct({ id: memories.employeeId }).from(memories);
  const total: TidyResult = { expired: 0, duplicates: 0, nearDuplicates: 0 };
  for (const { id } of emps) {
    try {
      const r = await tidyEmployeeMemories(id, now);
      total.expired += r.expired;
      total.duplicates += r.duplicates;
      total.nearDuplicates += r.nearDuplicates;
    } catch (e) {
      log.warn({ err: e, employeeId: id }, "memory tidy failed for an employee");
    }
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
