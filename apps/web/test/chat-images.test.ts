import { randomUUID } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { conversations, db, employees, members, messages, users, workspaces } from "@wfos/db";
import type { ChatMessageDTO } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as postMessage } from "@/app/api/conversations/[id]/messages/route";
import { GET as getImage } from "@/app/api/conversations/[id]/images/[imageId]/route";
import { call, resetBrowser } from "./browser";

// uploads land in a throwaway folder, not the repo's storage/ (set before the app's env module loads)
const storage = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/wfos-web-uploads-`);
  process.env.STORAGE_DIR = dir;
  return dir;
});

beforeEach(() => resetBrowser());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function signedIn() {
  const mk = async () => {
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    const [emp] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Sari", role: "Finance", model: "m" }).returning();
    const [conv] = await db.insert(conversations).values({ workspaceId: ws!.id, employeeId: emp!.id }).returning();
    return { ws: ws!, conv: conv! };
  };
  const a = await mk();
  const b = await mk();
  const email = `t-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: a.ws.id, userId: u!.id, role: "MEMBER" });
  expect((await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" })).status).toBe(200);
  return { a, b };
}

type Handler = (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function send(conversationId: string, content: string, files: File[]) {
  const form = new FormData();
  form.set("content", content);
  for (const f of files) form.append("files", f);
  const req = new NextRequest(`http://localhost:3010/api/conversations/${conversationId}/messages`, { method: "POST", body: form, headers: { "x-real-ip": "203.0.113.7" } });
  const res = await (postMessage as unknown as Handler)(req, { params: Promise.resolve({ id: conversationId }) });
  return { status: res.status, json: (await res.json()) as { message: ChatMessageDTO; code?: string } };
}

async function image(conversationId: string, imageId: string) {
  const req = new NextRequest(`http://localhost:3010/api/conversations/${conversationId}/images/${imageId}`, { headers: { "x-real-ip": "203.0.113.7" } });
  return (getImage as unknown as Handler)(req, { params: Promise.resolve({ id: conversationId, imageId }) });
}

describe("chat images", () => {
  it("stores a pasted image for the employee (not in the knowledge base) and serves it back to this workspace only", async () => {
    const { a, b } = await signedIn();
    const r = await send(a.conv.id, "What is wrong here?", [new File([PNG], "image.png", { type: "image/png" }), new File(["notes"], "notes.txt", { type: "text/plain" })]);
    expect(r.status).toBe(200);
    const [img, doc] = r.json.message.attachments!;
    expect(img).toMatchObject({ name: "image.png", mime: "image/png", size: PNG.length });
    expect(img!.imageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(img).not.toHaveProperty("storagePath");
    expect(doc).toMatchObject({ name: "notes.txt" });
    expect(doc!.documentId).toBeTruthy();

    // the row keeps where the file lives, under this workspace's upload folder
    const [row] = await db.select().from(messages).where(eq(messages.id, r.json.message.id));
    expect(row!.attachments[0]!.storagePath!.startsWith(path.join(storage, "uploads", a.ws.id) + path.sep)).toBe(true);

    const res = await image(a.conv.id, img!.imageId!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await image(a.conv.id, randomUUID())).status).toBe(404);
    // another workspace's conversation: not found, whatever the image id
    expect((await image(b.conv.id, img!.imageId!)).status).toBe(404);
  });

  it("checks images by their bytes and size before storing anything", async () => {
    const { a } = await signedIn();
    const fake = await send(a.conv.id, "look", [new File(["<svg onload=alert(1)>"], "evil.png", { type: "image/png" })]);
    expect(fake.status).toBe(400);
    expect(fake.json.code).toBe("unsupported_image_type");

    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await send(a.conv.id, "look", [new File(["hello"], "ok.txt"), new File([big], "huge.png", { type: "image/png" })]);
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.code).toBe("image_too_large");

    // neither message was stored
    expect(await db.select().from(messages).where(eq(messages.conversationId, a.conv.id))).toHaveLength(0);
  });
});
