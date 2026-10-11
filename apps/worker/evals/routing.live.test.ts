/**
 * Live routing eval: the real team-chat route classifier (classifyResponder, ROUTING_MODEL) on the labelled
 * messages in routing.labels.json. Opt-in: skipped unless EVAL_LIVE=1 and a real Claude credential is in the
 * environment (CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY with CLAUDE_AUTH_MODE=api_key).
 * Run: `EVAL_LIVE=1 pnpm --filter @wfos/worker eval:live` (see docs/EVALS.md for cost and thresholds).
 *
 * Reports accuracy (the classifier's own pick matches a label; a fallback counts as wrong), effective accuracy
 * (who would answer in production: a fallback goes to the lead), fallback rate, latency and cost; fails when
 * accuracy is below EVAL_MIN_ACCURACY (default 0.75).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it, vi } from "vitest";

// Nothing but the classifier may leave the process: Redis, SMTP and embeddings stay mocked as in the unit suite.
vi.mock("../src/lib/redis", async () => (await import("../test/transport")).redisModule);
vi.mock("@wfos/shared/mail", async () => (await import("../test/transport")).mailModule);
vi.mock("../src/lib/embeddings", async () => (await import("../test/transport")).embeddingsModule);

const apiKeyMode = process.env.CLAUDE_AUTH_MODE === "api_key";
const credential = (apiKeyMode ? process.env.ANTHROPIC_API_KEY : process.env.CLAUDE_CODE_OAUTH_TOKEN) ?? "";
const enabled = process.env.EVAL_LIVE === "1" && credential.length > 20 && credential !== "stub-token-never-sent";
const MIN_ACCURACY = Number(process.env.EVAL_MIN_ACCURACY ?? 0.75);
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 4));

type MemberKey = "lead" | "dev" | "finance" | "marketing";
type Label = MemberKey | "everyone";
interface Labels {
  team: Record<MemberKey, { name: string; role: string }>;
  messages: { text: string; expect: Label | Label[] }[];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(path.join(here, "routing.labels.json"), "utf8")) as Labels;

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

describe.skipIf(!enabled)("live: team-chat route classifier", () => {
  it(`routes ${labels.messages.length} labelled messages with accuracy >= ${MIN_ACCURACY}`, async () => {
    // the test environment of test/setup.ts, minus its stub credential (set before any app module loads)
    process.env.WFOS_ENV = "test";
    process.env.WFOS_NAMESPACE = "wfos-eval-live";
    process.env.DATABASE_URL = inject("databaseUrl");
    process.env.REDIS_URL = "redis://127.0.0.1:6379/14";
    process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "wfos-eval-"));
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.CLAUDE_INSTANCE_FALLBACK = "true";
    process.env.LOG_LEVEL = "silent";

    const { and, eq } = await import("drizzle-orm");
    const { conversations, db, employees, steps } = await import("@wfos/db");
    const { CREDIT_USD, ROUTING_MODEL } = await import("@wfos/shared");
    const { classifyResponder, ROUTE_EVERYONE } = await import("../src/runner/route-classifier");
    const { makeWorkspace } = await import("../test/fixtures");

    const ws = await makeWorkspace({ name: "Routing eval" });
    const ids = {} as Record<MemberKey, string>;
    const members: { id: string; name: string; role: string }[] = [];
    for (const key of ["lead", "dev", "finance", "marketing"] as const) {
      const m = labels.team[key];
      const [e] = await db.insert(employees).values({ workspaceId: ws.id, name: m.name, role: m.role, model: "claude-sonnet-5-5", autonomyLevel: "EXECUTE", dailyBudget: 200 }).returning();
      ids[key] = e!.id;
      members.push({ id: e!.id, name: m.name, role: m.role });
    }
    const keyOf = (id: string): Label | string => (id === ROUTE_EVERYONE ? "everyone" : ((Object.entries(ids).find(([, v]) => v === id)?.[0] as MemberKey | undefined) ?? id));

    const t0 = Date.now();
    const rows = await pool(labels.messages, CONCURRENCY, async (m) => {
      const [conv] = await db.insert(conversations).values({ workspaceId: ws.id }).returning();
      const started = Date.now();
      const d = await classifyResponder({ workspaceId: ws.id, conversationId: conv!.id, members, recentTranscript: "", newMessage: m.text, employeeId: ids.lead });
      const ms = Date.now() - started;
      const want = Array.isArray(m.expect) ? m.expect : [m.expect];
      const got = "pick" in d ? keyOf(d.pick) : null;
      const [step] = await db.select().from(steps).where(and(eq(steps.conversationId, conv!.id), eq(steps.name, "route_decision")));
      return {
        text: m.text,
        want,
        got,
        confidence: "pick" in d ? d.confidence : null,
        fallback: "fallback" in d ? d.fallback : null,
        correct: got !== null && want.includes(got as Label),
        // production: a fallback goes to the default responder (the lead)
        effective: want.includes((got ?? "lead") as Label),
        ms,
        credits: step?.credits ?? 0,
        model: step?.model ?? ROUTING_MODEL,
      };
    });

    const n = rows.length;
    const accuracy = rows.filter((r) => r.correct).length / n;
    const effective = rows.filter((r) => r.effective).length / n;
    const fallbackRate = rows.filter((r) => r.fallback).length / n;
    const credits = rows.reduce((a, r) => a + r.credits, 0);
    const fallbacks = Object.entries(rows.reduce<Record<string, number>>((a, r) => (r.fallback ? { ...a, [r.fallback]: (a[r.fallback] ?? 0) + 1 } : a), {}));
    const p50 = [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(n / 2)]!;
    const lines = rows.map(
      (r) =>
        `  ${r.correct ? "ok  " : r.fallback ? "FALL" : "MISS"}  want ${r.want.join("|").padEnd(18)} got ${(r.got ?? `fallback:${r.fallback}`).padEnd(18)} ${r.confidence?.toFixed(2) ?? "    "}  ${String(r.ms).padStart(5)}ms  ${r.text.slice(0, 70)}`,
    );
    console.log(
      [
        `live routing eval: ${n} messages, model ${rows[0]?.model}, concurrency ${CONCURRENCY}, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
        ...lines,
        `accuracy ${(accuracy * 100).toFixed(1)}% (threshold ${(MIN_ACCURACY * 100).toFixed(0)}%), effective ${(effective * 100).toFixed(1)}%, fallback rate ${(fallbackRate * 100).toFixed(1)}%${fallbacks.length ? ` (${fallbacks.map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`,
        `latency p50 ${p50} ms; cost ${credits.toFixed(4)} credits = $${(credits * CREDIT_USD).toFixed(5)} (${((credits * CREDIT_USD) / n).toFixed(6)} $/msg)`,
      ].join("\n"),
    );
    expect(accuracy, `routing accuracy ${accuracy.toFixed(3)} below ${MIN_ACCURACY}`).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });
});

describe.skipIf(enabled)("live: team-chat route classifier (skipped)", () => {
  it.skip("set EVAL_LIVE=1 and a real CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY with CLAUDE_AUTH_MODE=api_key)", () => {});
});
