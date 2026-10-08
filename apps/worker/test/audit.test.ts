import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { audit, getSql } from "@wfos/db";

describe("audit_log is append-only (Postgres trigger)", () => {
  const ws = randomUUID();

  it("accepts inserts", async () => {
    await audit({ workspaceId: ws, actorLabel: "test", action: "test.insert", targetType: "test" });
    const rows = await getSql()`select count(*)::int as n from audit_log where workspace_id = ${ws}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("rejects UPDATE", async () => {
    await expect(getSql()`update audit_log set action = 'tampered' where workspace_id = ${ws}`).rejects.toThrow(/append-only/);
  });

  it("rejects DELETE", async () => {
    await expect(getSql()`delete from audit_log where workspace_id = ${ws}`).rejects.toThrow(/append-only/);
  });

  it("rejects TRUNCATE", async () => {
    await expect(getSql()`truncate audit_log`).rejects.toThrow(/append-only/);
  });

  it("rejects UPDATE even when it matches no rows", async () => {
    await expect(getSql()`update audit_log set action = 'x' where false`).rejects.toThrow(/append-only/);
  });

  it("the row is still intact afterwards", async () => {
    const rows = await getSql()`select action from audit_log where workspace_id = ${ws}`;
    expect(rows.map((r) => r.action)).toEqual(["test.insert"]);
  });
});
