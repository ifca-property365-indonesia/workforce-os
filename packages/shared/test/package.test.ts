import { describe, expect, it } from "vitest";
import {
  PACKAGE_MAX_BYTES,
  packageFileName,
  packageKey,
  parseWfosPackage,
  renameMcpSelector,
  uniqueMcpName,
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
  ])("rejects %s", (_label, over, path) => {
    const r = parseWfosPackage(pkg(over));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
    expect(r.issues.map((i) => i.path)).toContain(path);
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
