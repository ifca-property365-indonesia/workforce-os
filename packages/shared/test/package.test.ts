import { describe, expect, it } from "vitest";
import {
  PACKAGE_MAX_BYTES,
  packageFileName,
  packageKey,
  parseWfosPackage,
  renameMcpSelector,
  SKILL_BODY_MAX,
  SKILL_SLUG_MAX,
  uniqueMcpName,
  truncateUtf8,
  uniqueSkillSlug,
  hasControlChars,
  isReservedSkillSlug,
  SKILL_RESERVED_SLUGS,
  stripControlChars,
  utf8Bytes,
  wfosPackageSchema,
} from "../src/index";
import { exportRedact, redactUrl } from "../src/server";

function pkg(over: Record<string, unknown> = {}) {
  return {
    format: "wfos.package",
    version: 1,
    meta: { name: "Sales", exportedAt: "2026-10-11T00:00:00.000Z" },
    employees: [
      { key: "dewi", name: "Dewi", avatar: "🤖", role: "Sales lead", persona: "", instructions: "", businessContext: "", model: "claude-sonnet-5-5", autonomyLevel: "QUEUE", toolPermissions: ["send_email", "mcp:crm", "mcp:crm:list_*"], outputLanguage: "id", executionMode: "tool", egressDomains: [] },
      { key: "budi", name: "Budi", role: "SDR", model: "claude-sonnet-5-5", seedMemories: [{ kind: "fact", content: "Prefers short emails" }] },
    ],
    teams: [{ key: "sales", name: "Sales", description: "", leadKey: "dewi", memberKeys: ["dewi", "budi"], responderMode: "lead" }],
    routines: [{ name: "Daily pipeline", cron: "0 9 * * 1-5", timezone: "Asia/Jakarta", brief: "Review the pipeline", teamKey: "sales", perClient: false, dryRun: false }],
    mcpSlots: [{ name: "crm", url: "https://crm.example.com/mcp" }],
    ...over,
  };
}

describe("wfosPackageSchema", () => {
  it("accepts a valid package and fills defaults", () => {
    const r = parseWfosPackage(pkg());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.employees[1]!.toolPermissions).toEqual([]);
    expect(r.pkg.employees[1]!.autonomyLevel).toBe("DRAFT");
    expect(wfosPackageSchema.safeParse(pkg()).success).toBe(true);
  });

  it("ignores unknown (future) fields", () => {
    const raw = pkg({ futureThing: { x: 1 } });
    (raw.employees[0] as Record<string, unknown>).hologram = true;
    const r = parseWfosPackage(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg).not.toHaveProperty("futureThing");
      expect(r.pkg.employees[0]).not.toHaveProperty("hologram");
    }
  });

  it("never keeps an allowList, credentials or ids even when a file carries them", () => {
    const raw = pkg();
    Object.assign(raw.employees[0]!, { allowList: [{ tool: "send_email" }], id: "0b6f…", secretEnc: "v1:x" });
    Object.assign(raw.mcpSlots[0]!, { token: "abc", authHeader: "X-Key" });
    const r = parseWfosPackage(raw);
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r.ok && r.pkg);
    expect(json).not.toMatch(/allowList|secretEnc|"id":|token|authHeader/);
  });

  it.each([
    ["a team lead that is not in the package", { teams: [{ key: "sales", name: "Sales", leadKey: "ghost", memberKeys: [] }] }, "teams.0.leadKey"],
    ["a member that is not in the package", { teams: [{ key: "sales", name: "Sales", leadKey: null, memberKeys: ["dewi", "ghost"] }] }, "teams.0.memberKeys.1"],
    ["a routine for an unknown team", { routines: [{ name: "R", cron: "0 9 * * *", brief: "b", teamKey: "ghost" }] }, "routines.0.teamKey"],
    ["a routine for an unknown employee", { routines: [{ name: "R", cron: "0 9 * * *", brief: "b", assigneeKey: "ghost" }] }, "routines.0.assigneeKey"],
    ["a routine without an assignee", { routines: [{ name: "R", cron: "0 9 * * *", brief: "b" }] }, "routines.0"],
    ["duplicate employee keys", { employees: [{ key: "dewi", name: "A", role: "r", model: "m" }, { key: "dewi", name: "B", role: "r", model: "m" }], teams: [], routines: [] }, "employees.1.key"],
    ["duplicate MCP slot names", { mcpSlots: [{ name: "crm", url: "https://a.example.com" }, { name: "crm", url: "https://b.example.com" }] }, "mcpSlots.1.name"],
    ["a key that is not a slug", { employees: [{ key: "Dewi Sales", name: "A", role: "r", model: "m" }], teams: [], routines: [] }, "employees.0.key"],
    ["an invalid tool selector", { employees: [{ key: "dewi", name: "A", role: "r", model: "m", toolPermissions: ["rm -rf"] }], teams: [], routines: [] }, "employees.0.toolPermissions.0"],
    ["a non-http MCP url", { mcpSlots: [{ name: "crm", url: "file:///etc/passwd" }] }, "mcpSlots.0.url"],
    ["an employee in two divisions", { teams: [{ key: "sales", name: "Sales", leadKey: "dewi", memberKeys: ["dewi", "budi"] }, { key: "ops", name: "Ops", leadKey: null, memberKeys: ["budi"] }] }, "teams.1.memberKeys.0"],
    ["subagents without a code lead", { teams: [{ key: "sales", name: "Sales", leadKey: "dewi", memberKeys: ["dewi"], subagentKeys: ["budi"] }] }, "teams.0"],
    ["a code lead who is a subagent", { teams: [{ key: "sales", name: "Sales", leadKey: "dewi", memberKeys: ["dewi"], codeLeadKey: "budi", subagentKeys: ["budi"] }] }, "teams.0"],
  ])("rejects %s", (_label, over, path) => {
    const r = parseWfosPackage(pkg(over));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
    expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it("reads a division with a code lead and subagents, and an older package's departments without failing", () => {
    const raw = pkg({
      employees: [
        { key: "pm", name: "Pratiwi", role: "PM", model: "m" },
        { key: "tl", name: "Arif", role: "Tech Lead", model: "m", executionMode: "workspace", department: "developer" },
        { key: "fe", name: "Citra", role: "Frontend", model: "m", specialty: "UI" },
      ],
      teams: [{ key: "delivery", name: "Delivery", leadKey: "pm", memberKeys: ["pm", "tl"], codeLeadKey: "tl", subagentKeys: ["fe"], sop: { en: "Ship it", id: "Kirim" }, color: "#4f7cff", maxParallel: 2 }],
      routines: [],
      departments: [{ key: "developer", name: { en: "Developer", id: "Developer" }, sop: { en: "", id: "" } }],
    });
    const r = parseWfosPackage(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.teams[0]).toMatchObject({ codeLeadKey: "tl", subagentKeys: ["fe"], maxParallel: 2 });
    expect(r.pkg.employees[2]!.specialty).toBe("UI");
  });

  it("rejects a package over 2 MB", () => {
    const big = "x".repeat(19_000);
    const employees = Array.from({ length: 120 }, (_, i) => ({ key: `e${i}`, name: `E${i}`, role: "r", model: "m", instructions: big }));
    const raw = pkg({ employees, teams: [], routines: [] });
    expect(JSON.stringify(raw).length).toBeGreaterThan(PACKAGE_MAX_BYTES);
    const r = parseWfosPackage(raw);
    expect(r).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("says a newer version made it, without a field list", () => {
    const r = parseWfosPackage({ ...pkg(), version: 2, employees: "a new shape" });
    expect(r).toMatchObject({ ok: false, reason: "newer_version" });
    if (!r.ok) {
      expect(r.message).toMatch(/made by a newer version/);
      expect(r.issues).toHaveLength(1);
    }
  });

  it("refuses something that is not a package", () => {
    expect(parseWfosPackage({ hello: "world" })).toMatchObject({ ok: false, reason: "not_a_package" });
    expect(parseWfosPackage([1, 2])).toMatchObject({ ok: false, reason: "not_a_package" });
    expect(parseWfosPackage({ ...pkg(), version: 0 })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("package skills", () => {
  const skills = [{ slug: "weekly-report", description: "How to write the weekly report", body: "# Weekly report\n\n1. Collect numbers" }];

  it("accepts skills and employee skill slugs (both optional)", () => {
    const raw = pkg({ skills });
    (raw.employees[0] as Record<string, unknown>).skillSlugs = ["weekly-report"];
    const r = parseWfosPackage(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.skills).toEqual(skills);
    expect(r.pkg.employees[0]!.skillSlugs).toEqual(["weekly-report"]);
    expect(r.pkg.employees[1]!.skillSlugs).toBeUndefined();
    const old = parseWfosPackage(pkg());
    expect(old.ok && old.pkg.skills).toBeUndefined();
  });

  it("drops anything but slug, description and body (no scripts or resources)", () => {
    const r = parseWfosPackage(pkg({ skills: [{ ...skills[0], scripts: { "run.sh": "curl evil" }, allowedTools: ["Bash"], source: "builtin", untrusted: false }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.pkg.skills![0]!).sort()).toEqual(["body", "description", "slug"]);
  });

  it.each([
    ["a slug that is not kebab-case", { skills: [{ ...skills[0], slug: "Weekly_Report" }] }, "skills.0.slug"],
    ["a slug that is too long", { skills: [{ ...skills[0], slug: "a".repeat(SKILL_SLUG_MAX + 1) }] }, "skills.0.slug"],
    ["an empty description", { skills: [{ ...skills[0], description: "" }] }, "skills.0.description"],
    ["a body over the limit", { skills: [{ ...skills[0], body: "x".repeat(SKILL_BODY_MAX + 1) }] }, "skills.0.body"],
    ["a body over the limit in UTF-8 bytes (not characters)", { skills: [{ ...skills[0], body: "é".repeat(SKILL_BODY_MAX / 2 + 1) }] }, "skills.0.body"],
    ["duplicate slugs", { skills: [skills[0], skills[0]] }, "skills.1.slug"],
  ])("rejects %s", (_label, over, path) => {
    const r = parseWfosPackage(pkg(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it("rejects an employee skill slug the package does not carry", () => {
    const raw = pkg({ skills });
    (raw.employees[1] as Record<string, unknown>).skillSlugs = ["weekly-report", "ghost"];
    const r = parseWfosPackage(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("employees.1.skillSlugs.1");
  });

  it("measures and cuts skill bodies in UTF-8 bytes", () => {
    expect(utf8Bytes("aé🤖")).toBe(1 + 2 + 4);
    expect(truncateUtf8("aé🤖", 6)).toBe("aé");
    expect(truncateUtf8("aé🤖", 7)).toBe("aé🤖");
    expect(parseWfosPackage(pkg({ skills: [{ ...skills[0], body: "é".repeat(SKILL_BODY_MAX / 2) }] })).ok).toBe(true);
  });

  it("finds a free skill slug", () => {
    expect(uniqueSkillSlug("weekly-report", new Set())).toBe("weekly-report");
    expect(uniqueSkillSlug("weekly-report", new Set(["weekly-report"]))).toBe("weekly-report-2");
    expect(uniqueSkillSlug("weekly-report", new Set(["weekly-report", "weekly-report-2"]))).toBe("weekly-report-3");
    const long = `${"a".repeat(SKILL_SLUG_MAX - 2)}-b`;
    const out = uniqueSkillSlug(long, new Set([long]));
    expect(out.length).toBeLessThanOrEqual(SKILL_SLUG_MAX);
    expect(out).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2$/);
  });

  it("treats the built-in skill names as taken", () => {
    expect(SKILL_RESERVED_SLUGS).toEqual(["pdf", "docx", "xlsx", "pptx"]);
    for (const slug of SKILL_RESERVED_SLUGS) {
      expect(isReservedSkillSlug(slug)).toBe(true);
      expect(uniqueSkillSlug(slug, new Set())).toBe(`${slug}-2`);
    }
    expect(uniqueSkillSlug("pdf", new Set(["pdf-2"]))).toBe("pdf-3");
    expect(isReservedSkillSlug("pdf-tools")).toBe(false);
    expect(uniqueSkillSlug("pdf-tools", new Set())).toBe("pdf-tools");
    // a reserved slug is still a valid package slug: it is renamed on import, not refused
    expect(parseWfosPackage(pkg({ skills: [{ ...skills[0], slug: "pdf" }] })).ok).toBe(true);
  });

  it("finds and strips C0 control characters (tab, LF and CR are allowed)", () => {
    expect(hasControlChars("a\tb\nc\r\n")).toBe(false);
    for (const c of ["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u001b", "\u001f"]) expect(hasControlChars(`x${c}y`)).toBe(true);
    expect(hasControlChars("\u007f é 🤖")).toBe(false);
    expect(stripControlChars("a\u0000b\u001b[0mc\td")).toBe("ab[0mc\td");
    expect(parseWfosPackage(pkg({ skills: [{ ...skills[0], body: "nul\u0000" }] })).ok).toBe(false);
    expect(parseWfosPackage(pkg({ skills: [{ ...skills[0], description: "esc\u001b" }] })).ok).toBe(false);
  });
});

describe("package helpers", () => {
  it("derives unique slug keys", () => {
    const taken = new Set<string>();
    expect(packageKey("Dewi Sales", taken)).toBe("dewi-sales");
    expect(packageKey("Dewi  sales!", taken)).toBe("dewi-sales-2");
    expect(packageKey("Ñoño", taken)).toBe("nono");
    expect(packageKey("🤖", taken)).toBe("item");
    expect(packageFileName("Sales Team")).toBe("sales-team.wfos.json");
  });

  it("finds a free MCP server name", () => {
    expect(uniqueMcpName("crm", new Set())).toBe("crm");
    expect(uniqueMcpName("crm", new Set(["crm"]))).toBe("crm-2");
    expect(uniqueMcpName("crm", new Set(["crm", "crm-2"]))).toBe("crm-3");
    const long = "a".repeat(32);
    expect(uniqueMcpName(long, new Set([long]))).toBe(`${"a".repeat(30)}-2`);
    expect(uniqueMcpName("my_crm_", new Set(["my_crm_"]))).toMatch(/^my_crm-2$/);
  });

  it("renames MCP selectors", () => {
    const m = new Map([["crm", "crm-2"]]);
    expect(renameMcpSelector("mcp:crm", m)).toBe("mcp:crm-2");
    expect(renameMcpSelector("mcp:crm:list_*", m)).toBe("mcp:crm-2:list_*");
    expect(renameMcpSelector("mcp:other:x", m)).toBe("mcp:other:x");
    expect(renameMcpSelector("send_email", m)).toBe("send_email");
  });
});

describe("redactUrl", () => {
  it.each([
    ["https://mcp.example.com/sse", "https://mcp.example.com/sse", []],
    ["https://mcp.example.com/mcp?token=abc123&team=sales", "https://mcp.example.com/mcp?token=&team=", ["url-query"]],
    ["https://mcp.example.com/mcp?flag", "https://mcp.example.com/mcp?flag=", []],
    ["https://user:hunter2@mcp.example.com/mcp", "https://mcp.example.com/mcp", ["url-userinfo"]],
    ["https://mcp.example.com/mcp#access_token=abc", "https://mcp.example.com/mcp", ["url-fragment"]],
    ["https://mcp.example.com/v1/a8f3k29dj3k4l5m6n7/mcp", "https://mcp.example.com/v1/redacted/mcp", ["url-key"]],
    ["https://hooks.example.com/T0123/B0456/abcdefghijklmnopqrstuvwxyz", "https://hooks.example.com/T0123/B0456/redacted", ["url-key"]],
    ["https://mcp.example.com/550e8400-e29b-41d4-a716-446655440000/mcp", "https://mcp.example.com/redacted/mcp", ["url-key"]],
    ["https://k9x8c7v6b5n4m3l2.mcp.example.com/mcp", "https://redacted.mcp.example.com/mcp", ["url-key"]],
    ["https://mcp.example.com/github-mcp-server-2024/mcp", "https://mcp.example.com/github-mcp-server-2024/mcp", []],
    ["https://mcp.example.com/v2/servers/notion-mcp-2025-06/sse", "https://mcp.example.com/v2/servers/notion-mcp-2025-06/sse", []],
    ["http://localhost:8080/mcp", "http://localhost:8080/mcp", []],
  ])("%s", (input, out, rules) => {
    const found: string[] = [];
    expect(redactUrl(input, found)).toBe(out);
    expect(found.sort()).toEqual([...rules].sort());
  });

  it("turns an unparseable URL into an empty string", () => {
    const found: string[] = [];
    expect(redactUrl("not a url", found)).toBe("");
    expect(found).toEqual(["url-invalid"]);
  });
});

describe("exportRedact", () => {
  it("redacts high and medium findings without excerpts", () => {
    const key = "sk-ant-api03-" + "A".repeat(40);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const r = exportRedact(`key ${key} jwt ${jwt} NIK 3171234567890123 password: hunter2222`);
    expect(r.text).not.toContain("sk-ant");
    expect(r.text).not.toContain("eyJ");
    expect(r.text).not.toContain("3171234567890123");
    expect(r.text).not.toContain("hunter");
    expect(r.text).toContain("[REDACTED:anthropic-key]");
    expect(r.rules).toEqual(expect.arrayContaining(["anthropic-key", "jwt", "nik-indonesia", "password-assignment"]));
  });

  it("redacts URLs inside text and leaves clean text alone", () => {
    expect(exportRedact("Post to https://hooks.example.com/x?key=s3cr3t when done").text).toBe("Post to https://hooks.example.com/x?key= when done");
    expect(exportRedact("Be friendly. See https://docs.example.com/guide.")).toEqual({ text: "Be friendly. See https://docs.example.com/guide.", rules: [] });
  });
});
