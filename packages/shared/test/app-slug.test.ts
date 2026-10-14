import { describe, expect, it } from "vitest";
import { appInstanceName, appSlugSchema, APP_INSTANCE_RE } from "../src/index";

describe("app slugs and instance names", () => {
  it("refuses slugs that could collide with another app's live instance", () => {
    expect(appSlugSchema.safeParse("shop").success).toBe(true);
    expect(appSlugSchema.safeParse("shop-live").success).toBe(false);
    expect(appSlugSchema.safeParse("livestream").success).toBe(true);
    expect(appSlugSchema.safeParse("www").success).toBe(false);
  });

  it("names the live instance <slug>-live, always a valid instance name", () => {
    expect(appInstanceName("shop", "preview")).toBe("shop");
    expect(appInstanceName("shop", "live")).toBe("shop-live");
    const longest = "a".repeat(30);
    expect(APP_INSTANCE_RE.test(appInstanceName(longest, "live"))).toBe(true);
  });
});
