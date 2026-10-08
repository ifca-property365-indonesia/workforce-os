import { describe, expect, it } from "vitest";
import { employeeOutputLocale, localeFromAcceptLanguage, resolveLocale } from "../src/index";

describe("locale resolution", () => {
  it.each([
    ["id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7", "id"],
    ["en-US,en;q=0.9", "en"],
    ["fr-FR,fr;q=0.9,en;q=0.5,id;q=0.4", "en"],
    ["en;q=0.3,id;q=0.8", "id"],
    ["in-ID", "id"],
    ["de-DE", null],
    ["", null],
    ["*", null],
    ["id;q=0", null],
  ])("Accept-Language %j → %s", (h, want) => expect(localeFromAcceptLanguage(h)).toBe(want));

  it("prefers user, then workspace, then browser, then English", () => {
    expect(resolveLocale("en", "id", "id")).toBe("en");
    expect(resolveLocale(null, "id", "en")).toBe("id");
    expect(resolveLocale(null, null, "id-ID")).toBe("id");
    expect(resolveLocale(null, null, "de")).toBe("en");
    expect(resolveLocale("xx", "yy", null)).toBe("en");
  });

  it("employee output language inherits the workspace default", () => {
    expect(employeeOutputLocale("inherit", "id")).toBe("id");
    expect(employeeOutputLocale("en", "id")).toBe("en");
    expect(employeeOutputLocale("inherit", null)).toBeNull();
    expect(employeeOutputLocale(undefined, "en")).toBe("en");
  });
});
