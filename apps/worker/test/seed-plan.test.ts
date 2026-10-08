import { describe, expect, it } from "vitest";
import { seedOwnerPlan } from "@wfos/db/seed-plan";

describe("seed owner", () => {
  it("creates no account by default (Docker's migrate step runs the seed on every start)", () => {
    expect(seedOwnerPlan({})).toBeNull();
  });
  it("SEED_DEMO=true gets a random password that must be changed at first login", () => {
    const a = seedOwnerPlan({ SEED_DEMO: "true" })!;
    const b = seedOwnerPlan({ SEED_DEMO: "true" })!;
    expect(a.password).not.toBe("workforce-demo");
    expect(a.password).not.toBe(b.password);
    expect(a.password.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatchObject({ email: "owner@workforce.local", mustChangePassword: true, generated: true });
  });
  it("an explicit password is used as is, and must not be trivially short", () => {
    expect(seedOwnerPlan({ SEED_OWNER_PASSWORD: "a-long-owner-pass", SEED_OWNER_EMAIL: "Me@Example.com" })).toMatchObject({ email: "me@example.com", password: "a-long-owner-pass", mustChangePassword: false });
    expect(() => seedOwnerPlan({ SEED_OWNER_PASSWORD: "short" })).toThrow();
  });
});
