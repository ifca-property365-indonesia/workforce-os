import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, members, pushSubscriptions, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { DELETE as unsubscribe, GET as config, POST as subscribe } from "@/app/api/me/push/route";
import manifest from "@/app/manifest";
import { call, resetBrowser } from "./browser";

beforeEach(() => {
  resetBrowser();
  process.env.VAPID_PUBLIC_KEY = "BPublicKeyForTests";
  process.env.VAPID_PRIVATE_KEY = "private-key-never-sent";
});
afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

async function signIn() {
  const email = `push-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "P", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "MEMBER" });
  resetBrowser();
  await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  return u!;
}
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("Web Push subscriptions", () => {
  it("exposes the public key only", async () => {
    await signIn();
    const r = await call(config, "GET", "/api/me/push");
    expect(r.json).toEqual({ enabled: true, publicKey: "BPublicKeyForTests" });
    expect(JSON.stringify(r.json)).not.toContain("private");
  });

  it("stores a push-service endpoint and refuses anything else", async () => {
    const u = await signIn();
    const ok = await call(subscribe, "POST", "/api/me/push", { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys });
    expect(ok.status).toBe(200);
    for (const endpoint of ["http://127.0.0.1:6379/", "https://169.254.169.254/latest/meta-data", "https://evil.example/push"]) {
      const r = await call(subscribe, "POST", "/api/me/push", { endpoint, keys });
      expect(r.status).toBe(400);
    }
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id))).toHaveLength(1);
  });

  it("a user can remove only their own subscription", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const a = await signIn();
    await call(subscribe, "POST", "/api/me/push", { endpoint, keys });
    await signIn(); // someone else
    await call(unsubscribe, "DELETE", "/api/me/push", { endpoint });
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(row?.userId).toBe(a.id);
  });

  it("a new sign-in on the same browser takes the endpoint over", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await signIn();
    await call(subscribe, "POST", "/api/me/push", { endpoint, keys });
    const b = await signIn();
    await call(subscribe, "POST", "/api/me/push", { endpoint, keys });
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(rows.map((r) => r.userId)).toEqual([b.id]);
  });
});

describe("manifest", () => {
  it("is installable: standalone, start URL, 192/512 and maskable icons", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/dashboard");
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}${i.purpose ? `:${i.purpose}` : ""}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512", "512x512:maskable"]));
  });
});
