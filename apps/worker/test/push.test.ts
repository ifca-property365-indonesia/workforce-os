import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, members, pushSubscriptions, users } from "@wfos/db";
import { pushNotify, setPushSender, type PushTarget } from "../src/lib/push";
import { makeWorkspace } from "./fixtures";
import { resetTransport } from "./transport";

let calls: { target: PushTarget; body: string }[] = [];
let failWith: number | null = null;

beforeEach(() => {
  resetTransport();
  calls = [];
  failWith = null;
  process.env.VAPID_PUBLIC_KEY = "BPub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  setPushSender(async (target, body) => {
    if (failWith) throw Object.assign(new Error("push error"), { statusCode: failWith });
    calls.push({ target, body });
    return { statusCode: 201 };
  });
});
afterEach(() => {
  setPushSender(null);
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

async function subscriber(workspaceId: string | null, endpoint: string) {
  const [u] = await db.insert(users).values({ email: `p-${randomUUID().slice(0, 8)}@test.local`, name: "P", passwordHash: "x" }).returning();
  if (workspaceId) await db.insert(members).values({ workspaceId, userId: u!.id, role: "MEMBER" });
  await db.insert(pushSubscriptions).values({ userId: u!.id, endpoint, p256dh: "k", auth: "a" });
  return u!;
}

describe("Web Push fan-out", () => {
  it("reaches members of the workspace only, with an in-app link", async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    await subscriber(ws.id, `https://fcm.googleapis.com/fcm/send/${randomUUID()}`);
    await subscriber(other.id, `https://fcm.googleapis.com/fcm/send/${randomUUID()}`);
    expect(await pushNotify(ws.id, "Task finished", "done", "/tasks/1")).toBe(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ title: "Task finished", body: "done", url: "/tasks/1" });
  });

  it("skips endpoints outside the push-service allow-list even if stored", async () => {
    const ws = await makeWorkspace();
    await subscriber(ws.id, `https://127.0.0.1/${randomUUID()}`);
    expect(await pushNotify(ws.id, "s", "t")).toBe(0);
    expect(calls).toEqual([]);
  });

  it("removes subscriptions the push service reports as gone", async () => {
    const ws = await makeWorkspace();
    const u = await subscriber(ws.id, `https://updates.push.services.mozilla.com/wpush/v2/${randomUUID()}`);
    failWith = 410;
    await pushNotify(ws.id, "s", "t");
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id))).toEqual([]);
  });

  it("does nothing without VAPID keys", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const ws = await makeWorkspace();
    await subscriber(ws.id, `https://fcm.googleapis.com/fcm/send/${randomUUID()}`);
    expect(await pushNotify(ws.id, "s", "t")).toBe(0);
  });
});
