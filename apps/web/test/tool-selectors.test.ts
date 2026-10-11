import { describe, expect, it } from "vitest";
import { decideGate, matchToolPermission, normalizeMcpName, toolPermissionSchema, type ToolPermission } from "@wfos/shared";
import {
  mcpToolKey,
  mcpToolRules,
  normalizePermissionKey,
  parseToolSelector,
  resolveMcpTool,
  setMcpToolAutonomy,
  toggleMcpTool,
  upsertPermission,
} from "@/lib/tool-selectors";
import { describeStep, stopReason } from "@/lib/step-labels";

describe("parseToolSelector", () => {
  it.each([
    ["list_*", "list_*"],
    ["  delete_contact ", "delete_contact"],
    ["crm.v2-get*", "crm_v2-get*"],
    ["*_draft", "*_draft"],
    ["GetHTTP", "gethttp"],
    ["Contacts.Delete*", "contacts_delete*"],
    ["a*b*c*d*e*f*g*h*", "a*b*c*d*e*f*g*h*"],
  ])("accepts %j, normalised as the gate compares it", (raw, out) => {
    expect(parseToolSelector(raw)).toBe(out);
    expect(toolPermissionSchema.safeParse({ tool: mcpToolKey("crm", out) }).success).toBe(true);
  });

  it.each(["", "   ", "*", "**", "list *", "mcp:crm", "a/b", "list_*;drop", "ünï", "a".repeat(129), "a*b*c*d*e*f*g*h*i*"])("rejects %j", (raw) => {
    expect(parseToolSelector(raw)).toBeNull();
  });
});

describe("MCP tool name normalisation", () => {
  const base: ToolPermission[] = [{ tool: "mcp:crm", enabled: true }];

  it("keys are normalised: a tool listed as Contacts.Delete saves mcp:<server>:contacts_delete", () => {
    const key = normalizeMcpName("Contacts.Delete");
    expect(key).toBe("contacts_delete");
    const off = toggleMcpTool(base, "crm", key, false);
    expect(off).toEqual([{ tool: "mcp:crm", enabled: true }, { tool: "mcp:crm:contacts_delete", enabled: false }]);
    expect(toolPermissionSchema.array().safeParse(off).success).toBe(true);
    // the panel, the gate's matcher and the gate itself agree, whichever spelling reaches them
    for (const name of ["contacts_delete", "Contacts.Delete"]) {
      const r = resolveMcpTool(off, "crm", name);
      expect(r).toMatchObject({ key: "mcp:crm:contacts_delete", enabled: false, own: { tool: "mcp:crm:contacts_delete" } });
      expect(matchToolPermission(r.key, off)?.enabled).toBe(r.enabled);
    }
    const gate = decideGate({ toolName: "mcp:crm:contacts_delete", toolClass: "irreversible", employeeAutonomy: "CLOSE", permissions: off, allowList: [], dryRun: false, scope: {} });
    expect(gate.kind).toBe("deny");
    expect(resolveMcpTool(toggleMcpTool(off, "crm", key, true), "crm", key).enabled).toBe(true);
    expect(toggleMcpTool(off, "crm", key, true)).toEqual(base);
  });

  it("a rule saved with the raw name still resolves, and the next edit migrates it to the normalised key", () => {
    const legacy: ToolPermission[] = [...base, { tool: "mcp:crm:Contacts.Delete", enabled: false }];
    const r = resolveMcpTool(legacy, "crm", "contacts_delete");
    expect(r).toMatchObject({ enabled: false, own: { tool: "mcp:crm:Contacts.Delete" }, blockedBy: undefined });
    expect(matchToolPermission(r.key, legacy)?.enabled).toBe(false);
    expect(normalizePermissionKey("mcp:crm:Contacts.Delete")).toBe("mcp:crm:contacts_delete");
    expect(normalizePermissionKey("mcp:crm:CRM.Delete*")).toBe("mcp:crm:crm_delete*");
    expect(normalizePermissionKey("mcp:crm")).toBe("mcp:crm");
    expect(normalizePermissionKey("send_email")).toBe("send_email");
    const on = toggleMcpTool(legacy, "crm", "contacts_delete", true);
    expect(on).toEqual(base);
    const tuned = setMcpToolAutonomy([...legacy, { tool: "mcp:crm:contacts_delete", enabled: false }], "crm", "Contacts.Delete", "DRAFT");
    expect(tuned).toEqual([...base, { tool: "mcp:crm:contacts_delete", enabled: true, autonomy: "DRAFT" }]);
  });

  it("a raw-name glob is reported normalised as the blocker", () => {
    const perms: ToolPermission[] = [...base, { tool: "mcp:crm:Contacts.*", enabled: false }];
    expect(resolveMcpTool(perms, "crm", "contacts_delete")).toMatchObject({ enabled: false, blockedBy: "mcp:crm:contacts_*" });
    expect(matchToolPermission("mcp:crm:contacts_delete", perms)?.enabled).toBe(false);
  });

  it("switching a tool off and on keeps its own autonomy (from the rule, or remembered by the editor)", () => {
    const tuned = setMcpToolAutonomy(base, "crm", "send_invoice", "DRAFT");
    const off = toggleMcpTool(tuned, "crm", "send_invoice", false);
    expect(off.at(-1)).toEqual({ tool: "mcp:crm:send_invoice", enabled: false });
    expect(toggleMcpTool(off, "crm", "send_invoice", true)).toEqual(base);
    expect(toggleMcpTool(off, "crm", "send_invoice", true, "DRAFT")).toEqual(tuned);
  });

  it("functional updates compose: two quick toggles both land", () => {
    const updates = [(p: ToolPermission[]) => toggleMcpTool(p, "crm", "a_tool", false), (p: ToolPermission[]) => toggleMcpTool(p, "crm", "b_tool", false)];
    const out = updates.reduce((cur, f) => f(cur), base);
    expect(mcpToolRules(out, "crm").map((p) => p.tool)).toEqual(["mcp:crm:a_tool", "mcp:crm:b_tool"]);
  });
});

describe("per-tool MCP rules", () => {
  const base: ToolPermission[] = [{ tool: "send_email", enabled: true }, { tool: "mcp:crm", enabled: true }];

  it("a tool without its own rule follows the server grant", () => {
    expect(resolveMcpTool(base, "crm", "list_contacts")).toMatchObject({ key: "mcp:crm:list_contacts", enabled: true, own: undefined, blockedBy: undefined });
    expect(resolveMcpTool([{ tool: "mcp:crm", enabled: false }], "crm", "list_contacts").enabled).toBe(false);
  });

  it("a disabled glob blocks matching tools and is reported as the blocker", () => {
    const perms = [...base, { tool: "mcp:crm:delete_*", enabled: false }, { tool: "mcp:crm:delete_note", enabled: true }];
    const r = resolveMcpTool(perms, "crm", "delete_note");
    expect(r).toMatchObject({ enabled: false, blockedBy: "mcp:crm:delete_*" });
    expect(resolveMcpTool(perms, "crm", "list_notes").enabled).toBe(true);
  });

  it("an enabled glob passes its autonomy down to the tools it covers", () => {
    const perms = [...base, { tool: "mcp:crm:send_*", enabled: true, autonomy: "DRAFT" as const }];
    expect(resolveMcpTool(perms, "crm", "send_invoice").inheritedAutonomy).toBe("DRAFT");
  });

  it("what the editor saves is what the gate enforces", () => {
    let perms = upsertPermission(base, mcpToolKey("crm", "delete_contact"), { tool: "mcp:crm:delete_contact", enabled: false });
    perms = upsertPermission(perms, mcpToolKey("crm", "list_*"), { tool: "mcp:crm:list_*", enabled: true });
    const gate = (tool: string) =>
      decideGate({ toolName: tool, toolClass: "irreversible", employeeAutonomy: "CLOSE", permissions: perms, allowList: [], dryRun: false, scope: {} }).kind;
    expect(gate("mcp:crm:delete_contact")).toBe("deny");
    expect(gate("mcp:crm:update_contact")).toBe("approval");
    expect(mcpToolRules(perms, "crm").map((p) => p.tool)).toEqual(["mcp:crm:delete_contact", "mcp:crm:list_*"]);
  });

  it("upsertPermission replaces in place, appends, and removes", () => {
    const a = upsertPermission(base, "mcp:crm", { tool: "mcp:crm", enabled: false });
    expect(a.map((p) => p.tool)).toEqual(["send_email", "mcp:crm"]);
    expect(a[1]!.enabled).toBe(false);
    expect(upsertPermission(base, "mcp:crm:x", { tool: "mcp:crm:x", enabled: false })).toHaveLength(3);
    expect(upsertPermission(base, "mcp:crm", null).map((p) => p.tool)).toEqual(["send_email"]);
  });
});

describe("describeStep", () => {
  it("reads gate steps", () => {
    expect(describeStep({ kind: "tool", name: "gate:crm/delete_contact", input: { rule: "not_granted", reason: "no" }, output: null })).toEqual({
      type: "gate",
      target: "crm/delete_contact",
      rule: "not_granted",
      reason: "no",
    });
    expect(describeStep({ kind: "tool", name: "gate:crm/x", input: { rule: "made_up" }, output: null })).toMatchObject({ rule: null });
  });

  it("reads incident, guard and stop steps", () => {
    expect(describeStep({ kind: "incident", name: "incident_opened:stalled", input: null, output: null })).toEqual({ type: "incident", action: "opened", kind: "stalled" });
    expect(describeStep({ kind: "guard", name: "repeat_detected", input: null, output: null })).toEqual({ type: "repeat" });
    expect(describeStep({ kind: "error", name: "run_failed", input: null, output: { stopped: "loop" } })).toEqual({ type: "stopped", reason: "loop" });
    expect(describeStep({ kind: "error", name: "run_stalled", input: null, output: "x" })).toEqual({ type: "stopped", reason: "stalled" });
    expect(describeStep({ kind: "error", name: "run_failed", input: null, output: { kind: "error" } })).toEqual({ type: "plain" });
    expect(describeStep({ kind: "tool", name: "loop_tasks", input: null, output: null })).toEqual({ type: "plain" });
  });

  it("does not read stop reasons out of unrelated words", () => {
    expect(stopReason("looping", null)).toBeNull();
    expect(stopReason("x", { reason: "loop" })).toBe("loop");
  });
});
