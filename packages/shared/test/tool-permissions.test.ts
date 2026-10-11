import { describe, expect, it } from "vitest";
import {
  applyRunSignals,
  classifyTool,
  globMatches,
  toolPermissionSchema,
  decideGate,
  effectiveAutonomy,
  matchToolPermission,
  toolPatternMatches,
  type GateInput,
  type ToolPermission,
} from "../src/index";

describe("toolPatternMatches", () => {
  it("matches exact names, for builtins and external selectors", () => {
    expect(toolPatternMatches("send_email", "send_email")).toBe(true);
    expect(toolPatternMatches("send_email", "send_invoice")).toBe(false);
    expect(toolPatternMatches("mcp:crm:list_contacts", "mcp:crm:list_contacts")).toBe(true);
    expect(toolPatternMatches("mcp:crm:list_contacts", "mcp:crm:list_deals")).toBe(false);
  });

  it("a server-level grant covers every tool of that server only", () => {
    expect(toolPatternMatches("mcp:crm", "mcp:crm:list_contacts")).toBe(true);
    expect(toolPatternMatches("mcp:crm", "mcp:crm:delete_contact")).toBe(true);
    expect(toolPatternMatches("mcp:crm", "mcp:crmx:list_contacts")).toBe(false);
    expect(toolPatternMatches("mcp:cr", "mcp:crm:list_contacts")).toBe(false);
    expect(toolPatternMatches("mcp:other", "mcp:crm:list_contacts")).toBe(false);
  });

  it.each([
    ["mcp:crm:list_*", "mcp:crm:list_contacts", true],
    ["mcp:crm:list_*", "mcp:crm:list_", true],
    ["mcp:crm:list_*", "mcp:crm:get_list_contacts", false],
    ["mcp:crm:*_contact", "mcp:crm:delete_contact", true],
    ["mcp:crm:*_contact", "mcp:crm:delete_contacts", false],
    ["mcp:crm:get_*_by_id", "mcp:crm:get_deal_by_id", true],
    ["mcp:crm:get_*_by_id", "mcp:crm:get_deal_by_name", false],
    ["mcp:crm:*", "mcp:crm:anything", true],
    ["mcp:crm:list_*", "mcp:sales:list_contacts", false],
  ] as const)("glob %s vs %s → %s", (pattern, tool, want) => {
    expect(toolPatternMatches(pattern, tool)).toBe(want);
  });

  it("escapes regex metacharacters in the literal parts of a glob", () => {
    expect(toolPatternMatches("mcp:x:a.b*", "mcp:x:a.bc")).toBe(true);
    expect(toolPatternMatches("mcp:x:a.b*", "mcp:x:aXbc")).toBe(false);
    expect(toolPatternMatches("mcp:x:(get)+*", "mcp:x:(get)+all")).toBe(true);
    expect(toolPatternMatches("mcp:x:(get)+*", "mcp:x:getgetall")).toBe(false);
    expect(toolPatternMatches("mcp:x:[ab]*", "mcp:x:a1")).toBe(false);
    expect(toolPatternMatches("mcp:x:$^*", "mcp:x:$^z")).toBe(true);
  });

  it("a pattern without * is not a glob, and non-mcp names only match exactly", () => {
    expect(toolPatternMatches("mcp:crm:list_", "mcp:crm:list_contacts")).toBe(false);
    expect(toolPatternMatches("send_*", "send_email")).toBe(false);
    expect(toolPatternMatches("mcp:crm", "send_email")).toBe(false);
    expect(toolPatternMatches("mcp:crm:*", "mcp:crm")).toBe(false);
    expect(toolPatternMatches("mcp:crm", "mcp:crm")).toBe(true);
  });
});

describe("matchToolPermission", () => {
  const perms: ToolPermission[] = [
    { tool: "mcp:crm", enabled: true },
    { tool: "mcp:crm:list_*", enabled: true, autonomy: "EXECUTE" },
    { tool: "mcp:crm:list_contacts", enabled: true, autonomy: "CLOSE" },
    { tool: "mcp:crm:delete_*", enabled: false },
    { tool: "send_email", enabled: true },
  ];

  it("an explicit disabled entry wins over a broader grant", () => {
    expect(matchToolPermission("mcp:crm:delete_contact", perms)).toEqual({ tool: "mcp:crm:delete_*", enabled: false });
    expect(matchToolPermission("mcp:crm:delete_contact", [{ tool: "mcp:crm:delete_contact", enabled: true }, { tool: "mcp:crm", enabled: false }])?.enabled).toBe(false);
  });

  it("the most specific enabled entry decides autonomy: exact > glob > server", () => {
    expect(matchToolPermission("mcp:crm:list_contacts", perms)?.tool).toBe("mcp:crm:list_contacts");
    expect(matchToolPermission("mcp:crm:list_deals", perms)?.tool).toBe("mcp:crm:list_*");
    expect(matchToolPermission("mcp:crm:update_deal", perms)?.tool).toBe("mcp:crm");
    expect(effectiveAutonomy("mcp:crm:list_contacts", "QUEUE", perms)).toBe("CLOSE");
    expect(effectiveAutonomy("mcp:crm:list_deals", "QUEUE", perms)).toBe("EXECUTE");
    expect(effectiveAutonomy("mcp:crm:update_deal", "QUEUE", perms)).toBe("QUEUE");
  });

  it("the longer literal part wins between two globs", () => {
    const p: ToolPermission[] = [
      { tool: "mcp:crm:*", enabled: true, autonomy: "DRAFT" },
      { tool: "mcp:crm:send_*", enabled: true, autonomy: "CLOSE" },
    ];
    expect(matchToolPermission("mcp:crm:send_note", p)?.tool).toBe("mcp:crm:send_*");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchToolPermission("mcp:sales:list_deals", perms)).toBeUndefined();
    expect(matchToolPermission("send_invoice", perms)).toBeUndefined();
    expect(matchToolPermission("send_email", [])).toBeUndefined();
  });
});

describe("decideGate rules", () => {
  const base = (over: Partial<GateInput>): GateInput => ({
    toolName: "mcp:crm:send_note",
    toolClass: "irreversible",
    employeeAutonomy: "EXECUTE",
    permissions: [{ tool: "mcp:crm", enabled: true }],
    allowList: [],
    dryRun: false,
    ...over,
  });

  it.each([
    ["not_granted", base({ permissions: [] }), "deny"],
    ["not_granted", base({ permissions: [{ tool: "mcp:crm", enabled: true }, { tool: "mcp:crm:send_*", enabled: false }] }), "deny"],
    ["reversible", base({ toolClass: "reversible" }), "run"],
    ["dry_run", base({ dryRun: true }), "simulate"],
    ["autonomy_draft", base({ employeeAutonomy: "DRAFT" }), "draft"],
    ["autonomy_draft", base({ permissions: [{ tool: "mcp:crm", enabled: true }, { tool: "mcp:crm:send_*", enabled: true, autonomy: "DRAFT" }] }), "draft"],
    ["allow_list", base({ employeeAutonomy: "CLOSE", allowList: [{ tool: "mcp:crm", recipientDomains: [], clientIds: [] }] }), "run"],
    ["autonomy", base({ employeeAutonomy: "CLOSE" }), "approval"],
    ["autonomy", base({ employeeAutonomy: "EXECUTE" }), "approval"],
  ] as const)("rule %s → %s", (rule, input, kind) => {
    const d = decideGate(input);
    expect(d.kind).toBe(kind);
    expect(d.rule).toBe(rule);
  });

  it("run signals set taint / leak rules on an otherwise allowed irreversible call", () => {
    const run = decideGate(base({ employeeAutonomy: "CLOSE", allowList: [{ tool: "mcp:crm", recipientDomains: [], clientIds: [] }] }));
    expect(applyRunSignals(run, { toolClass: "irreversible", tainted: true })).toMatchObject({ kind: "approval", rule: "taint" });
    expect(applyRunSignals(run, { toolClass: "irreversible", tainted: false, highLeak: true })).toMatchObject({ kind: "approval", rule: "leak" });
    expect(applyRunSignals(run, { toolClass: "irreversible", tainted: false })).toEqual(run);
  });

  it("allow-list entries match with globs and server-level selectors", () => {
    const close = (tool: string, entry: string) =>
      decideGate(
        base({ toolName: tool, employeeAutonomy: "CLOSE", allowList: [{ tool: entry, recipientDomains: [], clientIds: [] }] }),
      ).kind;
    expect(close("mcp:crm:send_note", "mcp:crm:send_*")).toBe("run");
    expect(close("mcp:crm:delete_note", "mcp:crm:send_*")).toBe("approval");
    expect(close("mcp:crm:delete_note", "mcp:crm")).toBe("run");
    expect(close("mcp:crm:send_note", "mcp:sales")).toBe("approval");
    expect(close("mcp:crm:send_note", "mcp:crm:send_note")).toBe("run");
  });
});

describe("gate regressions from the Phase 2 review", () => {
  it.each([
    "get_and_close_ticket", "fetch_and_release_funds", "read_and_post_message", "find_and_archive_emails",
    "list_then_post", "getAndPostComment", "search_close", "get_post_then_delete",
  ])("chained or verb-like name %s fails closed", (name) => {
    expect(classifyTool(`mcp__s__${name}`)).toBe("irreversible");
  });

  it.each(["get_post", "list_posts", "get_release", "list_release_notes", "getPostComments"])("%s is a read", (name) => {
    expect(classifyTool(`mcp__s__${name}`)).toBe("reversible");
  });

  it("a disabled rule governs the SDK-normalised name regardless of case and punctuation", () => {
    const perms = [
      { tool: "mcp:crm", enabled: true },
      { tool: "mcp:crm:delete_*", enabled: false },
      { tool: "mcp:crm:Contacts.Archive", enabled: false },
    ];
    expect(matchToolPermission("mcp:crm:Delete_Contact", perms)?.enabled).toBe(false);
    expect(matchToolPermission("mcp:crm:DELETECONTACT", perms)?.enabled).toBe(true); // no "_" after delete: not covered
    expect(matchToolPermission("mcp:crm:contacts_archive", perms)?.enabled).toBe(false);
    expect(matchToolPermission("mcp:crm:list_contacts", perms)?.enabled).toBe(true);
  });

  it("server segment must match exactly", () => {
    expect(toolPatternMatches("mcp:crm", "mcp:crmx:list")).toBe(false);
    expect(toolPatternMatches("mcp:crm:*", "mcp:crmx:list")).toBe(false);
  });

  it("glob matching is linear (no catastrophic backtracking)", () => {
    const glob = `mcp:s:${"a*".repeat(8)}b`;
    const started = Date.now();
    expect(toolPatternMatches(glob, `mcp:s:${"a".repeat(5000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("globMatches basics", () => {
    expect(globMatches("list_*", "list_contacts")).toBe(true);
    expect(globMatches("*_delete", "contact_delete")).toBe(true);
    expect(globMatches("a*b*c", "abc")).toBe(true);
    expect(globMatches("a*b*c", "acb")).toBe(false);
    expect(globMatches("*", "")).toBe(true);
  });

  it("toolPermissionSchema rejects malformed selectors", () => {
    expect(toolPermissionSchema.safeParse({ tool: "mcp:crm:list_*" }).success).toBe(true);
    expect(toolPermissionSchema.safeParse({ tool: "send_email" }).success).toBe(true);
    expect(toolPermissionSchema.safeParse({ tool: "mcp:crm:" + "*".repeat(9) }).success).toBe(false);
    expect(toolPermissionSchema.safeParse({ tool: "mcp:a__b:x" }).success).toBe(false);
    expect(toolPermissionSchema.safeParse({ tool: "rm -rf" }).success).toBe(false);
  });
});
