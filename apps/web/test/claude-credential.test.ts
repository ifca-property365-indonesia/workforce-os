import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db, members, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { DELETE, GET, PUT } from "@/app/api/settings/claude/route";
import { GET as me } from "@/app/api/me/route";
import { call, resetBrowser } from "./browser";

const SECRET = "sk-ant-oat01-" + "s3cr3t".repeat(8) + "Ab12";

async function signedIn(role: "OWNER" | "ADMIN" | "MEMBER") {
  const email = `u-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return ws!;
}

beforeEach(() => resetBrowser());

describe("workspace Claude credential API", () => {
  it("an Owner can set it; responses never contain the secret", async () => {
    await signedIn("OWNER");
    const put = await call(PUT, "PUT", "/api/settings/claude", { type: "oauth", secret: SECRET });
    expect(put.status).toBe(200);
    for (const r of [put, await call(GET, "GET", "/api/settings/claude"), await call(me, "GET", "/api/me")]) {
      expect(JSON.stringify(r.json)).not.toContain("s3cr3t");
    }
    const get = await call(GET, "GET", "/api/settings/claude");
    expect(get.json.workspace).toMatchObject({ type: "oauth", last4: "Ab12" });
    expect(get.json.effective).toMatchObject({ source: "workspace" });
  });

  it("an Admin can see the status but not change it", async () => {
    await signedIn("ADMIN");
    expect((await call(GET, "GET", "/api/settings/claude")).status).toBe(200);
    expect((await call(PUT, "PUT", "/api/settings/claude", { type: "oauth", secret: SECRET })).status).toBe(403);
    expect((await call(DELETE, "DELETE", "/api/settings/claude")).status).toBe(403);
  });

  it("a Member cannot see it", async () => {
    await signedIn("MEMBER");
    expect((await call(GET, "GET", "/api/settings/claude")).status).toBe(403);
  });

  it("rejects an API key saved as a subscription token", async () => {
    await signedIn("OWNER");
    const r = await call(PUT, "PUT", "/api/settings/claude", { type: "oauth", secret: "sk-ant-api03-" + "x".repeat(30) });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("claude_credential_type_mismatch");
  });

  it("removing it falls back to the instance credential only when that is enabled", async () => {
    process.env.CLAUDE_INSTANCE_FALLBACK = "false";
    await signedIn("OWNER");
    await call(PUT, "PUT", "/api/settings/claude", { type: "oauth", secret: SECRET });
    const del = await call(DELETE, "DELETE", "/api/settings/claude");
    expect(del.json.workspace).toBeNull();
    expect(del.json.effective).toBeNull();
    delete process.env.CLAUDE_INSTANCE_FALLBACK;
  });
});
