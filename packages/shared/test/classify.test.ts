import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, classifyTool } from "../src/index";

describe("classifyTool", () => {
  it.each(BUILTIN_TOOLS.map((t) => [t.name, t.class] as const))("builtin %s is %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it("classifies every irreversible builtin as irreversible", () => {
    const irreversible = BUILTIN_TOOLS.filter((t) => t.class === "irreversible").map((t) => t.name).sort();
    expect(irreversible).toEqual(["post_webhook", "send_email", "send_invoice"]);
  });

  it("uses the registry for builtins reached through an mcp__ prefix", () => {
    expect(classifyTool("mcp__wfos__send_email")).toBe("irreversible");
    expect(classifyTool("mcp__wfos__kb_search")).toBe("reversible");
  });

  it.each([
    ["mcp__github__list_issues", "reversible"],
    ["mcp__github__get_file_contents", "reversible"],
    ["mcp__drive__search_files", "reversible"],
    ["mcp__github__create_pull_request", "irreversible"],
    ["mcp__github__merge_pull_request", "irreversible"],
    ["mcp__slack__post_message", "irreversible"],
    ["mcp__stripe__refund_charge", "irreversible"],
    ["mcp__db__delete_rows", "irreversible"],
  ] as const)("verb heuristic for external tool %s → %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it("is irreversible when a name mixes a read verb with a write verb", () => {
    expect(classifyTool("mcp__x__list_and_delete")).toBe("irreversible");
    expect(classifyTool("get_or_create_user")).toBe("irreversible");
  });

  it.each(["frobnicate", "mcp__weird__do_the_thing", "mcp__srv__", "", "mcp__", "Bash", "WebFetch", "x"])(
    "unknown name %j fails closed",
    (name) => {
      expect(classifyTool(name)).toBe("irreversible");
    },
  );

  it("does not trust camelCase/compound tricks to look reversible", () => {
    // tokens are split on non-letters only; "listAll" is one token and not a known read verb
    expect(classifyTool("mcp__x__listAll")).toBe("irreversible");
  });

  it("overrides win by full name and by bare name", () => {
    expect(classifyTool("mcp__crm__sync_contacts", { mcp__crm__sync_contacts: "reversible" })).toBe("reversible");
    expect(classifyTool("mcp__crm__sync_contacts", { sync_contacts: "reversible" })).toBe("reversible");
    expect(classifyTool("kb_search", { kb_search: "irreversible" })).toBe("irreversible");
    expect(classifyTool("mcp__crm__list_contacts", { other: "reversible" })).toBe("reversible");
  });
});
