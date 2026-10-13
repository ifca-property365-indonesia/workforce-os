import { describe, expect, it } from "vitest";
import {
  AUTONOMY_LEVELS,
  allowListMatches,
  applyRunSignals,
  decideGate,
  emailPayloadSchema,
  invoicePayloadSchema,
  parseSingleAddress,
  type AllowListEntry,
  type AutonomyLevel,
  type GateDecision,
  type GateInput,
  type ToolClass,
} from "../src/index";

const allow: AllowListEntry = { tool: "send_email", recipientDomains: ["client.co.id"], clientIds: [], note: "" };

function input(over: Partial<GateInput>): GateInput {
  return {
    toolName: "send_email",
    toolClass: "irreversible",
    employeeAutonomy: "EXECUTE",
    permissions: [{ tool: "send_email", enabled: true }],
    allowList: [],
    dryRun: false,
    scope: { recipients: ["a@client.co.id"] },
    ...over,
  };
}

/** Expected outcome, written out independently of the implementation. */
function expected(level: AutonomyLevel, cls: ToolClass, dryRun: boolean, allowMatch: boolean): GateDecision["kind"] {
  if (cls === "reversible") return "run";
  if (dryRun) return "simulate";
  if (level === "DRAFT") return "draft";
  if (level === "CLOSE" && allowMatch) return "run";
  return "approval";
}

describe("decideGate matrix", () => {
  const cases: [AutonomyLevel, ToolClass, boolean, boolean][] = [];
  for (const level of AUTONOMY_LEVELS)
    for (const cls of ["reversible", "irreversible"] as ToolClass[])
      for (const dryRun of [false, true]) for (const allowMatch of [false, true]) cases.push([level, cls, dryRun, allowMatch]);

  it("covers 4 × 2 × 2 × 2 = 32 combinations", () => expect(cases).toHaveLength(32));

  it.each(cases)("autonomy=%s class=%s dryRun=%s allowListMatch=%s", (level, cls, dryRun, allowMatch) => {
    const d = decideGate(
      input({
        employeeAutonomy: level,
        toolClass: cls,
        dryRun,
        allowList: [allow],
        scope: { recipients: [allowMatch ? "a@client.co.id" : "a@elsewhere.com"] },
      }),
    );
    expect(d.kind).toBe(expected(level, cls, dryRun, allowMatch));
  });
});

describe("decideGate grants", () => {
  it("denies a tool that is not granted, whatever its class", () => {
    expect(decideGate(input({ permissions: [] })).kind).toBe("deny");
    expect(decideGate(input({ toolClass: "reversible", permissions: [] })).kind).toBe("deny");
  });

  it("denies a tool that is granted but disabled", () => {
    expect(decideGate(input({ permissions: [{ tool: "send_email", enabled: false }] })).kind).toBe("deny");
  });

  it("deny wins over dry run", () => {
    expect(decideGate(input({ permissions: [], dryRun: true })).kind).toBe("deny");
  });

  it("per-tool autonomy override beats the employee level", () => {
    const perms = [{ tool: "send_email", enabled: true, autonomy: "DRAFT" as const }];
    expect(decideGate(input({ employeeAutonomy: "CLOSE", permissions: perms, allowList: [allow] })).kind).toBe("draft");
    const up = [{ tool: "send_email", enabled: true, autonomy: "CLOSE" as const }];
    expect(decideGate(input({ employeeAutonomy: "DRAFT", permissions: up, allowList: [allow] })).kind).toBe("run");
  });

  it("an allow-list entry for another tool does not apply", () => {
    expect(decideGate(input({ employeeAutonomy: "CLOSE", allowList: [{ ...allow, tool: "send_invoice" }] })).kind).toBe("approval");
  });
});

describe("allowListMatches scope", () => {
  const base: AllowListEntry = { tool: "send_invoice", recipientDomains: [], clientIds: [], note: "" };
  it("requires every recipient in an allowed domain", () => {
    const e = { ...base, recipientDomains: ["@client.co.id"] };
    expect(allowListMatches(e, { recipients: ["a@client.co.id", "b@CLIENT.co.id"] })).toBe(true);
    expect(allowListMatches(e, { recipients: ["a@client.co.id", "b@evil.com"] })).toBe(false);
    expect(allowListMatches(e, { recipients: [] })).toBe(false);
    expect(allowListMatches(e, { recipients: ["no-at-sign"] })).toBe(false);
    expect(allowListMatches(e, { recipients: ["a@sub.client.co.id"] })).toBe(false);
  });
  it("enforces client ids and max amount (missing amount fails)", () => {
    expect(allowListMatches({ ...base, clientIds: ["c1"] }, { clientId: "c2" })).toBe(false);
    expect(allowListMatches({ ...base, clientIds: ["c1"] }, { clientId: null })).toBe(false);
    expect(allowListMatches({ ...base, maxAmount: 100 }, { amount: 100 })).toBe(true);
    expect(allowListMatches({ ...base, maxAmount: 100 }, { amount: 101 })).toBe(false);
    expect(allowListMatches({ ...base, maxAmount: 100 }, {})).toBe(false);
  });
});

describe("parseSingleAddress", () => {
  it("accepts one bare or named address, lower-cased", () => {
    expect(parseSingleAddress("Ana@Client.co.id")).toBe("ana@client.co.id");
    expect(parseSingleAddress("  Ana Wijaya <ana@client.co.id> ")).toBe("ana@client.co.id");
    expect(parseSingleAddress('"Ana" <Ana@X.com>')).toBe("ana@x.com");
    expect(parseSingleAddress("first.last+tag@sub.client.co.id")).toBe("first.last+tag@sub.client.co.id");
  });
  it("rejects anything a mailer could split into several addresses", () => {
    for (const raw of [
      "evil@x.com, <ok@allowed.com>",
      "evil@x.com; ok@allowed.com",
      "evil@x.com\nok@allowed.com",
      "Evil <evil@x.com> <ok@allowed.com>",
      "evil@x.com <ok@allowed.com>",
      "a@b@allowed.com",
      "Name <a@x.com",
      '"a@x.com" <ok@allowed.com>',
      "no-at-sign",
      "@allowed.com",
      "a@",
      "a b@allowed.com",
      "a@allowed..com",
      "",
    ]) {
      expect(parseSingleAddress(raw), raw).toBeNull();
    }
  });
});

describe("allow-list: multi-address recipient strings never match", () => {
  const exploit = "evil@x.com, <ok@allowed.com>";
  const base: AllowListEntry = { tool: "send_email", recipientDomains: [], clientIds: [], note: "" };
  it("domain, exact and clientContactsOnly rules all refuse it", () => {
    expect(allowListMatches({ ...base, recipientDomains: ["allowed.com"] }, { recipients: [exploit] })).toBe(false);
    expect(allowListMatches({ ...base, recipients: ["ok@allowed.com"] }, { recipients: [exploit] })).toBe(false);
    expect(allowListMatches({ ...base, clientContactsOnly: true }, { recipients: [exploit], clientId: "c1", clientRecipients: ["ok@allowed.com"] })).toBe(false);
    expect(decideGate(input({ employeeAutonomy: "CLOSE", allowList: [{ ...base, recipientDomains: ["allowed.com"] }], scope: { recipients: [exploit] } })).kind).toBe("approval");
  });
  it("a named single address still matches; domain-only entries are unchanged", () => {
    expect(allowListMatches({ ...base, recipientDomains: ["b.com"] }, { recipients: ["Name <a@b.com>"] })).toBe(true);
    expect(allowListMatches({ ...base, recipients: ["A@B.com"] }, { recipients: ["Name <a@b.com>"] })).toBe(true);
    expect(allowListMatches({ ...base, clientContactsOnly: true }, { recipients: ["Ana <ana@b.com>"], clientId: "c1", clientRecipients: ["ana@b.com"] })).toBe(true);
    expect(allowListMatches({ ...base, recipientDomains: ["client.co.id"] }, { recipients: ["a@client.co.id", "b@client.co.id"] })).toBe(true);
  });
  it("a rule configured with only blank values matches nobody", () => {
    expect(allowListMatches({ ...base, recipientDomains: [""] }, { recipients: ["a@client.co.id"] })).toBe(false);
    expect(allowListMatches({ ...base, recipientDomains: ["  ", "@"] }, { recipients: ["a@client.co.id"] })).toBe(false);
    expect(allowListMatches({ ...base, recipients: [""] }, { recipients: ["a@client.co.id"] })).toBe(false);
    // no recipient rule at all: recipients are not restricted
    expect(allowListMatches(base, { recipients: ["a@client.co.id"] })).toBe(true);
  });
  it("payload schemas refuse a recipient that is not exactly one address", () => {
    const email = { subject: "s", body: "b" };
    expect(emailPayloadSchema.safeParse({ ...email, to: [exploit] }).success).toBe(false);
    expect(emailPayloadSchema.safeParse({ ...email, to: ["ok@allowed.com"], cc: [exploit] }).success).toBe(false);
    expect(emailPayloadSchema.safeParse({ ...email, to: ["Ana <ana@allowed.com>"] }).success).toBe(true);
    const inv = { clientId: "c", invoiceNumber: "INV-1", lines: [{ description: "x", quantity: 1, unitPrice: 1 }], dueDate: "2026-11-30" };
    expect(invoicePayloadSchema.safeParse({ ...inv, to: [exploit] }).success).toBe(false);
    expect(invoicePayloadSchema.safeParse({ ...inv, to: [] }).success).toBe(true);
  });
});

describe("applyRunSignals (injection taint, leak guard)", () => {
  const allowListed = decideGate(input({ employeeAutonomy: "CLOSE", allowList: [allow] }));

  it("precondition: the action is allow-listed and would run", () => expect(allowListed.kind).toBe("run"));

  it("taint forces approval for an allow-listed irreversible action", () => {
    expect(applyRunSignals(allowListed, { toolClass: "irreversible", tainted: true }).kind).toBe("approval");
  });

  it("a high-severity leak forces approval", () => {
    expect(applyRunSignals(allowListed, { toolClass: "irreversible", tainted: false, highLeak: true }).kind).toBe("approval");
  });

  it("an untainted allow-listed action still runs", () => {
    expect(applyRunSignals(allowListed, { toolClass: "irreversible", tainted: false }).kind).toBe("run");
  });

  it("never loosens a stricter decision", () => {
    for (const d of [{ kind: "deny", reason: "x" }, { kind: "draft", reason: "x" }, { kind: "simulate", reason: "x" }, { kind: "approval", reason: "x" }] as GateDecision[]) {
      expect(applyRunSignals(d, { toolClass: "irreversible", tainted: true, highLeak: true })).toEqual(d);
    }
  });

  it("leaves reversible tools alone", () => {
    expect(applyRunSignals({ kind: "run" }, { toolClass: "reversible", tainted: true }).kind).toBe("run");
  });
});
