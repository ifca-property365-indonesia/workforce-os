import { describe, expect, it } from "vitest";
import { loadScenarios, parseScenario, runScenario, scoreEvidence, scoreTable } from "./scenario-runner";

/**
 * Every test/scenarios/*.json as one vitest case (docs/EVALS.md). Part of the normal suite: the scenarios are
 * hermetic (throwaway Postgres, scripted SDK, mocked Redis/queues/SMTP) and run in seconds.
 * EVAL_VERBOSE=1 prints every score table, not only the failing ones.
 */
const scenarios = loadScenarios();
const verbose = process.env.EVAL_VERBOSE === "1";

describe.each(scenarios.map((s) => [s.name, s] as const))("scenario %s", (_name, s) => {
  it(
    s.description,
    async () => {
      const r = await runScenario(s);
      const failed = r.scores.filter((x) => !x.pass);
      if (failed.length) console.error(scoreTable(r));
      else if (verbose) console.log(scoreTable(r));
      expect(failed.map((x) => `${x.scorer}: ${x.detail}`), scoreTable(r)).toEqual([]);
    },
    s.timeoutMs ?? 20_000,
  );
});

describe("scenario format", () => {
  const minimal = {
    name: "x",
    description: "x",
    setup: { employees: [{ key: "sari" }] },
    trigger: { kind: "task", task: "t" },
    expect: [{ scorer: "noMailSent" }],
  };

  it("there is at least one scenario file", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("the scorers can fail: inverted expectations on a real run are all reported as failures", async () => {
    const base = scenarios.find((s) => s.name === "allowlisted_close_send_unattended")!;
    const r = await runScenario(base);
    const inverted = parseScenario({
      ...base,
      expect: [
        { scorer: "noMailSent" },
        { scorer: "approvalCreated", tool: "send_email" },
        { scorer: "taskStatus", task: "status", status: "FAILED" },
        { scorer: "taskTainted", task: "status" },
        { scorer: "taskStatus", task: "no_such_task", status: "DONE" },
      ],
    });
    const scores = scoreEvidence(inverted, r.evidence);
    expect(scores.map((x) => x.pass)).toEqual([false, false, false, false, false]);
    expect(scoreTable({ name: "inverted", scores })).toMatch(/^scenario inverted: 0\/5 expectations passed\n {2}FAIL {2}noMailSent/);
    // the evidence is frozen: a scorer cannot change what the next one sees
    expect(Object.isFrozen(r.evidence.tasks[0])).toBe(true);
  });

  it("accepts a minimal scenario", () => {
    expect(() => parseScenario(minimal)).not.toThrow();
  });

  it("rejects a malformed scenario with the path of the bad field", () => {
    expect(() => parseScenario({ ...minimal, setup: { employees: [{ key: "sari", autonomyLevel: "YOLO" }] } })).toThrow(/setup\.employees\.0\.autonomyLevel/);
    expect(() => parseScenario({ ...minimal, trigger: { kind: "nope" } })).toThrow(/trigger/);
    expect(() => parseScenario({ ...minimal, scripts: { sari: [{ tool: "x" }] } })).toThrow(/scripts\.sari/);
  });

  it("rejects an unknown scorer, bad scorer arguments, and scripts for an unknown employee", () => {
    expect(() => parseScenario({ ...minimal, expect: [{ scorer: "vibes" }] })).toThrow(/unknown scorer "vibes"/);
    expect(() => parseScenario({ ...minimal, expect: [{ scorer: "taskStatus", task: "t", status: "MAYBE" }] })).toThrow(/expect\[0\] \(taskStatus\)/);
    expect(() => parseScenario({ ...minimal, expect: [{ scorer: "noMailSent", extra: 1 }] })).toThrow(/expect\[0\]/);
    expect(() => parseScenario({ ...minimal, scripts: { budi: [{ result: "x" }] } })).toThrow(/scripts\.budi names no employee/);
  });
});
