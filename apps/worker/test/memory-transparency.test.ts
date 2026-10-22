import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, memories, memoryEvents, steps } from "@wfos/db";
import { memoryPreviewKey } from "@wfos/shared";
import { recallMemories } from "../src/runner/prompt";
import { previewMemories } from "../src/runner/memory-preview";
import { LESSON_MIN_FEEDBACK, parseLessons, writeLessons } from "../src/scheduler/memory-tidy";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { redis } from "../src/lib/redis";
import { env } from "../src/lib/env";
import { makeEmployee, makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

function model(text: string) {
  const prompts: string[] = [];
  setQueryImpl(((p: Parameters<QueryFn>[0]) => {
    prompts.push(String(p.prompt));
    return mockRunner([{ llm: { input: 80, output: 20, text } }, { result: text }]).query(p);
  }) as QueryFn);
  return prompts;
}

async function employeeWith(rows: { kind: string; content: string; untrusted?: boolean; createdAt?: Date }[]) {
  const ws = await makeWorkspace();
  const emp = await makeEmployee(ws.id);
  const ids: string[] = [];
  for (const r of rows) {
    const [m] = await db.insert(memories).values({ workspaceId: ws.id, employeeId: emp.id, source: "user", untrusted: false, ...r }).returning();
    ids.push(m!.id);
  }
  return { ws, emp, ids };
}

describe("memory you can see being used", () => {
  it("recall gives ids, puts lessons before feedback, and counts a use without touching updated_at", async () => {
    const { emp, ids } = await employeeWith([
      { kind: "feedback", content: "Pakai bahasa formal ke klien." },
      { kind: "lesson", content: "Selalu cek nomor invoice sebelum kirim." },
      { kind: "fact", content: "Klien PT Maju bayar tiap tanggal 5." },
    ]);
    const before = await db.select().from(memories).where(eq(memories.id, ids[0]!));
    const got = await recallMemories(emp.id, "kirim invoice ke PT Maju");
    expect(got.map((m) => m.kind)).toEqual(["lesson", "feedback", "fact"]);
    expect(got[0]).toMatchObject({ id: ids[1], content: "Lesson from past reviewer feedback: Selalu cek nomor invoice sebelum kirim." });
    const [after] = await db.select().from(memories).where(eq(memories.id, ids[0]!));
    expect(after!.uses).toBe(1);
    expect(after!.lastUsedAt).toBeInstanceOf(Date);
    expect(after!.updatedAt.getTime()).toBe(before[0]!.updatedAt.getTime());

    await recallMemories(emp.id, "x", null, { countUse: false });
    expect((await db.select().from(memories).where(eq(memories.id, ids[0]!)))[0]!.uses).toBe(1);
  });

  it("lessons have their own slots: fresh reviewer feedback is always recalled", async () => {
    const lessons = Array.from({ length: 8 }, (_, i) => ({ kind: "lesson", content: `Pelajaran nomor ${i}` }));
    const { emp } = await employeeWith([...lessons, { kind: "feedback", content: "Koreksi terbaru dari reviewer" }]);
    const got = await recallMemories(emp.id, "apa saja");
    expect(got.filter((m) => m.kind === "lesson")).toHaveLength(3);
    expect(got.some((m) => m.content === "Feedback from a human reviewer: Koreksi terbaru dari reviewer")).toBe(true);
  });

  it("a preview leaves what recall would give in Redis and is not a use", async () => {
    const { ws, emp, ids } = await employeeWith([{ kind: "feedback", content: "Jangan kirim di akhir pekan." }]);
    await previewMemories({ kind: "memory_preview", workspaceId: ws.id, employeeId: emp.id, brief: "kirim laporan", clientId: null, requestId: "11111111-1111-4111-8111-111111111111" });
    const raw = await redis.get(memoryPreviewKey(env.namespace, "11111111-1111-4111-8111-111111111111"));
    expect(JSON.parse(raw!)).toEqual([{ id: ids[0], kind: "feedback", content: "Feedback from a human reviewer: Jangan kirim di akhir pekan.", untrusted: false }]);
    expect((await db.select().from(memories).where(eq(memories.id, ids[0]!)))[0]!.uses).toBe(0);
  });
});

describe("lessons from recurring feedback", () => {
  const feedback = (n: number, untrusted = false) =>
    Array.from({ length: n }, (_, i) => ({ kind: "feedback", content: `Subjek email terlalu panjang (${i})`, untrusted }));

  it("sums up recurring trusted feedback as lesson memories, journaled; not again within a week", async () => {
    const prompts = model('{"lessons":["Buat subjek email singkat, paling banyak 8 kata."]}');
    const { ws, emp } = await employeeWith(feedback(LESSON_MIN_FEEDBACK));
    expect(await writeLessons(ws.id, emp.id)).toBe(1);
    const [l] = await db.select().from(memories).where(and(eq(memories.employeeId, emp.id), eq(memories.kind, "lesson")));
    expect(l).toMatchObject({ source: "tidy", untrusted: false, content: "Buat subjek email singkat, paling banyak 8 kata." });
    expect(prompts[0]).toContain("<feedback>\n- Subjek email terlalu panjang");
    expect(await db.select().from(memoryEvents).where(eq(memoryEvents.memoryId, l!.id))).toHaveLength(1);
    expect(await db.select().from(steps).where(and(eq(steps.employeeId, emp.id), eq(steps.name, "memory_lessons")))).toHaveLength(1);

    expect(await writeLessons(ws.id, emp.id)).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  it("untrusted feedback does not count, too little feedback asks nothing, and a repeated lesson is not added", async () => {
    const prompts = model('{"lessons":["Buat subjek email singkat, paling banyak 8 kata."]}');
    const a = await employeeWith([...feedback(LESSON_MIN_FEEDBACK - 1), ...feedback(3, true)]);
    expect(await writeLessons(a.ws.id, a.emp.id)).toBe(0);
    expect(prompts).toHaveLength(0);

    const b = await employeeWith([...feedback(LESSON_MIN_FEEDBACK), { kind: "lesson", content: "Buat subjek email singkat, paling banyak 8 kata.", createdAt: new Date(Date.now() - 30 * 86_400_000) }]);
    expect(await writeLessons(b.ws.id, b.emp.id)).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  it("parses at most three sensible lessons", () => {
    expect(parseLessons('{"lessons":["ok","Satu aturan yang jelas.","Dua aturan yang jelas.","Tiga aturan yang jelas.","Empat aturan yang jelas."]}')).toEqual([
      "Satu aturan yang jelas.",
      "Dua aturan yang jelas.",
      "Tiga aturan yang jelas.",
    ]);
    expect(parseLessons("no json")).toEqual([]);
  });
});
