import { describe, expect, it } from "vitest";
import { clientInputSchema, divisionStructureError, projectInputSchema, teamInputSchema } from "../src/index";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("division structure", () => {
  it("accepts a head, a code lead and subagents", () => {
    expect(
      divisionStructureError({
        leadId: A,
        codeLeadId: B,
        members: [
          { employeeId: A, role: "member" },
          { employeeId: B, role: "member" },
          { employeeId: C, role: "subagent" },
        ],
      }),
    ).toBeNull();
  });

  it.each([
    ["a duplicate member", { leadId: null, codeLeadId: null, members: [{ employeeId: A, role: "member" as const }, { employeeId: A, role: "member" as const }] }],
    ["a head who is not a member", { leadId: A, codeLeadId: null, members: [] }],
    ["a head who is a subagent", { leadId: A, codeLeadId: B, members: [{ employeeId: A, role: "subagent" as const }, { employeeId: B, role: "member" as const }] }],
    ["a code lead who is a subagent", { leadId: null, codeLeadId: B, members: [{ employeeId: B, role: "subagent" as const }] }],
    ["the head as code lead", { leadId: A, codeLeadId: A, members: [{ employeeId: A, role: "member" as const }] }],
    ["subagents without a code lead", { leadId: A, codeLeadId: null, members: [{ employeeId: A, role: "member" as const }, { employeeId: C, role: "subagent" as const }] }],
  ])("rejects %s", (_label, d) => {
    expect(divisionStructureError(d)).not.toBeNull();
  });

  it("teamInputSchema applies the rules and fills division defaults", () => {
    const ok = teamInputSchema.safeParse({ name: "Support", leadId: A, members: [{ employeeId: A }] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toMatchObject({ codeLeadId: null, maxParallel: 1, sop: { en: "", id: "" }, members: [{ employeeId: A, role: "member" }] });
    expect(teamInputSchema.safeParse({ name: "Support", leadId: A, members: [] }).success).toBe(false);
    expect(teamInputSchema.safeParse({ name: "X", leadId: null, members: [], key: "Bad Key" }).success).toBe(false);
    expect(teamInputSchema.safeParse({ name: "X", leadId: null, members: [], maxParallel: 0 }).success).toBe(false);
  });
});

describe("clients and projects", () => {
  it("client codes are short upper-case slugs or empty", () => {
    expect(clientInputSchema.parse({ name: "PT Grand Outlet Bali", code: "GOB" }).code).toBe("GOB");
    expect(clientInputSchema.parse({ name: "No code" }).code).toBe("");
    expect(clientInputSchema.safeParse({ name: "x", code: "gob" }).success).toBe(false);
    expect(clientInputSchema.safeParse({ name: "x", code: "A" }).success).toBe(false);
  });

  it("projects carry a responsible division and a health status", () => {
    const p = projectInputSchema.parse({ clientId: A, name: "Portal", teamId: B, health: "at_risk", startDate: "2026-10-01" });
    expect(p).toMatchObject({ teamId: B, health: "at_risk", startDate: "2026-10-01", nextMilestone: "", nextStep: "" });
    expect(projectInputSchema.safeParse({ clientId: A, name: "x", health: "fine" }).success).toBe(false);
  });
});
