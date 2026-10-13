import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, classifyTool } from "../src/index";

describe("classifyTool", () => {
  it.each(BUILTIN_TOOLS.map((t) => [t.name, t.class] as const))("builtin %s is %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it("classifies every irreversible builtin as irreversible", () => {
    const irreversible = BUILTIN_TOOLS.filter((t) => t.class === "irreversible").map((t) => t.name).sort();
    expect(irreversible).toEqual(["create_pull_request", "git_push", "post_webhook", "request_preview", "send_email", "send_invoice"]);
  });

  it("request_preview is irreversible although its name holds the read verb \"preview\" (the registry wins)", () => {
    expect(classifyTool("request_preview")).toBe("irreversible");
    expect(classifyTool("mcp__wfos__request_preview")).toBe("irreversible");
    expect(classifyTool("list_apps")).toBe("reversible");
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

  it.each(["frobnicate", "mcp__weird__do_the_thing", "mcp__srv__", "", "mcp__", "Bash", "TodoWrite", "x", "mcp__x__LISTALL", "mcp__x__listingsSync"])(
    "unknown name %j fails closed",
    (name) => {
      expect(classifyTool(name)).toBe("irreversible");
    },
  );

  it.each([
    // camelCase / PascalCase / acronym boundaries are word boundaries
    ["mcp__crm__listContacts", "reversible"],
    ["mcp__crm__ListContacts", "reversible"],
    ["mcp__x__listAll", "reversible"],
    ["mcp__http__getHTTPResponse", "reversible"],
    ["mcp__http__HTTPGetResponse", "reversible"],
    ["mcp__x__fetchURLs2Json", "reversible"],
    ["mcp__crm__searchCRMRecords", "reversible"],
    ["mcp__gmail__sendEmail", "irreversible"],
    ["mcp__gmail__SendEmail", "irreversible"],
    ["mcp__crm__deleteContact", "irreversible"],
    ["mcp__crm__getOrCreateContact", "irreversible"],
    ["mcp__crm__listAndDeleteContacts", "irreversible"],
    ["mcp__x__POSTData", "irreversible"],
    ["mcp__x__readThenUpdateRow", "irreversible"],
    // snake_case unchanged
    ["send_email", "irreversible"],
    ["mcp__crm__list_contacts", "reversible"],
    ["mcp__crm__get_HTTP_response", "reversible"],
  ] as const)("splits camelCase before classifying %s → %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it.each([
    // a leading read verb names a read even when a later token is a noun that doubles as a verb
    ["mcp__blog__get_post", "reversible"],
    ["mcp__github__list_releases", "reversible"],
    ["mcp__tickets__list_closed_issues", "reversible"],
    // outbound verbs are irreversible wherever they appear
    ["mcp__slack__send_message", "irreversible"],
    ["mcp__slack__reply_to_thread", "irreversible"],
    ["mcp__drive__share_doc", "irreversible"],
    ["mcp__mail__forward_email", "irreversible"],
    ["mcp__x__get_and_delete_file", "irreversible"],
    ["mcp__x__fetchAndDelete", "irreversible"],
    // any other write verb after a leading read still fails closed
    ["mcp__crm__getOrCreateContact", "irreversible"],
    ["mcp__x__readThenUpdateRow", "irreversible"],
    ["mcp__x__list_then_write", "irreversible"],
  ] as const)("outbound verbs and leading reads: %s → %s", (name, cls) => {
    expect(classifyTool(name)).toBe(cls);
  });

  it("a verb glued inside a longer lowercase word is not a verb", () => {
    expect(classifyTool("mcp__x__listall")).toBe("irreversible");
    expect(classifyTool("mcp__x__getaway")).toBe("irreversible");
  });

  it("overrides win by full name and by bare name", () => {
    expect(classifyTool("mcp__crm__sync_contacts", { mcp__crm__sync_contacts: "reversible" })).toBe("reversible");
    expect(classifyTool("mcp__crm__sync_contacts", { sync_contacts: "reversible" })).toBe("reversible");
    expect(classifyTool("kb_search", { kb_search: "irreversible" })).toBe("irreversible");
    expect(classifyTool("mcp__crm__list_contacts", { other: "reversible" })).toBe("reversible");
  });
});

describe("classifyTool release noun/verb", () => {
  it("reads a release after a leading read verb", () => {
    expect(classifyTool("mcp__gh__get_release")).toBe("reversible");
    expect(classifyTool("mcp__gh__list_release")).toBe("reversible");
  });
  it("still fails closed for release as a verb", () => {
    expect(classifyTool("mcp__gh__release_version")).toBe("irreversible");
    expect(classifyTool("mcp__gh__create_release")).toBe("irreversible");
  });
});
