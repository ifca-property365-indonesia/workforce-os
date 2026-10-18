import { describe, expect, it } from "vitest";
import { appManifestSchema, isForbiddenAppEnv, parseTestUsersOutput } from "../src/index";

const line = (users: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ users, ...extra });

describe("testUsers (C10)", () => {
  it("the manifest takes an optional testUsers command (one line)", () => {
    expect(appManifestSchema.parse({ type: "nextjs" }).testUsers).toBeUndefined();
    expect(appManifestSchema.parse({ type: "nextjs", testUsers: "pnpm test-users" }).testUsers).toBe("pnpm test-users");
    expect(appManifestSchema.safeParse({ type: "nextjs", testUsers: "a\nb" }).success).toBe(false);
  });

  it("WFOS_TEST_PASSWORD is the platform's: a person cannot set it", () => {
    expect(isForbiddenAppEnv("WFOS_TEST_PASSWORD")).toBe(true);
  });

  it("reads the last JSON line, after any log lines, with defaults", () => {
    const out = ["seeding…", '{"not":"this one"}', line([{ role: "admin", label: "Admin", username: "admin@test" }, { role: "req", label: "Requester", username: "req@test", totp: "jbsw y3dp ehpk 3pxp", loginPath: "/login", viewAll: true }], { note: "2 roles" })].join("\n");
    const r = parseTestUsersOutput(out);
    expect(r).toEqual({
      ok: true,
      value: {
        users: [
          { role: "admin", label: "Admin", username: "admin@test", loginPath: "/", viewAll: false, note: "" },
          { role: "req", label: "Requester", username: "req@test", totp: "JBSWY3DPEHPK3PXP", loginPath: "/login", viewAll: true, note: "" },
        ],
        note: "2 roles",
      },
    });
  });

  it("refuses no JSON, bad JSON, unknown keys (a password), bad roles, duplicate roles, a bad TOTP key, too many", () => {
    expect(parseTestUsersOutput("done")).toMatchObject({ ok: false, error: expect.stringMatching(/no JSON line/) });
    expect(parseTestUsersOutput("{users: 1}")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseTestUsersOutput(line([{ role: "a", label: "A", username: "u", password: "secret" }]))).toMatchObject({ ok: false });
    expect(parseTestUsersOutput(line([{ role: "a b", label: "A", username: "u" }]))).toMatchObject({ ok: false });
    expect(parseTestUsersOutput(line([{ role: "a", label: "A", username: "u" }, { role: "a", label: "B", username: "v" }]))).toMatchObject({ ok: false, error: expect.stringMatching(/"a" appears twice/) });
    expect(parseTestUsersOutput(line([{ role: "a", label: "A", username: "u", totp: "not-base32!" }]))).toMatchObject({ ok: false });
    expect(parseTestUsersOutput(line([{ role: "a", label: "A", username: "u", loginPath: "https://evil.example/" }]))).toMatchObject({ ok: false });
    expect(parseTestUsersOutput(line(Array.from({ length: 21 }, (_, i) => ({ role: `r${i}`, label: "R", username: `u${i}` }))))).toMatchObject({ ok: false });
    expect(parseTestUsersOutput(line([]))).toMatchObject({ ok: false });
  });
});
