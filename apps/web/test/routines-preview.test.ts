import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, members, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as preview } from "@/app/api/routines/preview/route";
import { previewCron } from "@/lib/server/cron-preview";
import { call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

async function signIn(opts: { role?: "VIEWER" | "MEMBER"; locale?: "en" | "id"; wsTz?: string } = {}) {
  const [ws] = await db
    .insert(workspaces)
    .values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false, timezone: opts.wsTz ?? "Asia/Jakarta" })
    .returning();
  const email = `rp-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "R", passwordHash: await bcrypt.hash("pw-123456", 4), locale: opts.locale ?? "en" }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: opts.role ?? "MEMBER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return ws!;
}

describe("POST /api/routines/preview", () => {
  it("describes a valid rule and lists the next three runs in its time zone", async () => {
    await signIn({ wsTz: "Asia/Makassar" });
    const r = await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "Asia/Jakarta" });
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(true);
    expect(r.json.label).toBe("At 09:00, only on Monday");
    expect(r.json.displayTimezone).toBe("Asia/Makassar");
    const runs = r.json.nextRuns as string[];
    expect(runs).toHaveLength(3);
    for (const x of runs) {
      const d = new Date(x);
      // 09:00 in Jakarta (UTC+7) is 02:00 UTC, on a Monday
      expect(d.getUTCHours()).toBe(2);
      expect(d.getUTCDay()).toBe(1);
      expect(d.getTime()).toBeGreaterThan(Date.now());
    }
    expect(new Date(runs[1]!).getTime() - new Date(runs[0]!).getTime()).toBe(7 * 86400_000);
  });

  it("honours the time zone", () => {
    const from = new Date("2026-01-05T00:00:00Z");
    const utc = previewCron("0 9 * * *", "UTC", "en", 1, from);
    const jkt = previewCron("0 9 * * *", "Asia/Jakarta", "en", 1, from);
    expect(utc).toMatchObject({ valid: true, nextRuns: ["2026-01-05T09:00:00.000Z"] });
    expect(jkt).toMatchObject({ valid: true, nextRuns: ["2026-01-05T02:00:00.000Z"] });
  });

  it("labels the rule in Indonesian for an Indonesian user", async () => {
    await signIn({ locale: "id" });
    const r = await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "Asia/Jakarta" });
    expect(r.json).toMatchObject({ valid: true, label: "Pada 09:00, hanya pada Senin" });
  });

  it("reports an invalid rule without failing the request, in the user's language", async () => {
    await signIn();
    const r = await call(preview, "POST", "/api/routines/preview", { cron: "61 * * * *", timezone: "UTC" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ valid: false, code: "invalid_cron", label: null, nextRuns: [] });
    expect(r.json.error).toMatch(/^This rule is not valid: .*61/);
    const junk = await call(preview, "POST", "/api/routines/preview", { cron: "a b c d e", timezone: "UTC" });
    expect(junk.json).toMatchObject({ valid: false, code: "invalid_cron" });
  });

  it("asks for exactly five fields, like saving a routine does, in the user's language", async () => {
    await signIn();
    const six = await call(preview, "POST", "/api/routines/preview", { cron: "0 0 9 * * 1", timezone: "UTC" });
    expect(six.json).toMatchObject({ valid: false, code: "cron_fields", label: null, nextRuns: [] });
    expect(six.json.error).toBe("A rule has exactly 5 fields (minute hour day month weekday); this one has 6 fields.");
    const two = await call(preview, "POST", "/api/routines/preview", { cron: "every monday", timezone: "UTC" });
    expect(two.json).toMatchObject({ code: "cron_fields" });
    resetBrowser();
    await signIn({ locale: "id" });
    const id = await call(preview, "POST", "/api/routines/preview", { cron: "0 0 9 * * 1", timezone: "UTC" });
    expect(id.json.error).toMatch(/^Aturan harus terdiri dari tepat 5 bagian.*6 bagian/);
    expect(previewCron(" 0  9 * * 1 ", "UTC", "en")).toMatchObject({ valid: true });
  });

  it("rejects an unknown time zone", async () => {
    await signIn({ locale: "id" });
    const r = await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "Mars/Olympus" });
    expect(r.json).toMatchObject({ valid: false, code: "invalid_timezone" });
    expect(r.json.error).toContain("Mars/Olympus");
    expect(r.json.error).toMatch(/Zona waktu/);
  });

  it("validates the body; viewers may preview (pure computation), signed-out callers may not", async () => {
    await signIn();
    expect((await call(preview, "POST", "/api/routines/preview", { cron: "", timezone: "UTC" })).status).toBe(400);
    expect((await call(preview, "POST", "/api/routines/preview", { timezone: "UTC" })).status).toBe(400);
    resetBrowser();
    await signIn({ role: "VIEWER" });
    const v = await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "UTC" });
    expect(v.status).toBe(200);
    expect(v.json.valid).toBe(true);
    resetBrowser();
    expect((await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "UTC" })).status).toBe(401);
  });

  it("is rate limited per user: 60 a minute", async () => {
    await signIn({ role: "VIEWER" });
    for (let i = 0; i < 60; i++) expect((await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "UTC" })).status).toBe(200);
    const over = await call(preview, "POST", "/api/routines/preview", { cron: "0 9 * * 1", timezone: "UTC" });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("too_many_attempts");
  });
});
