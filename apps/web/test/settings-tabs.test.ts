import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_SETTINGS_TABS, SETTINGS_TABS, settingsTab } from "@/lib/settings-tabs";

describe("settings ?tab=", () => {
  it("opens a tab the person can see, and General otherwise", () => {
    expect(settingsTab("integrations", true)).toBe("integrations");
    expect(settingsTab("api", false)).toBe("api");
    for (const admin of ADMIN_SETTINGS_TABS) expect(settingsTab(admin, false)).toBe("general");
    for (const bad of [null, undefined, "", "nope", "__proto__", "constructor", "INTEGRATIONS"]) expect(settingsTab(bad, true)).toBe("general");
  });

  it("matches the tabs the page renders (admin-only triggers are exactly the admin tabs)", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/app/(app)/settings/page.tsx"), "utf8");
    const adminOnly = [...src.matchAll(/\{admin && <TabsTrigger value="([\w-]+)"/g)].map((m) => m[1]);
    const everyone = [...src.matchAll(/^\s*<TabsTrigger value="([\w-]+)"/gm)].map((m) => m[1]);
    expect(adminOnly.sort()).toEqual([...ADMIN_SETTINGS_TABS].sort());
    expect(everyone.sort()).toEqual([...SETTINGS_TABS].sort());
  });
});
