import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, messages } from "@wfos/db";
import { CHAT_IMAGE_TYPES } from "@wfos/shared";
import { notFound, route } from "@/lib/server/route";
import { serverEnv } from "@/lib/server/env";
import { conversationIn } from "../../thread";

/**
 * An image attached to a message of this conversation (the thread renders it). Only images of this workspace's
 * conversation are served, by the id stored on the message; the file path never comes from the request.
 */
export const GET = route<{ id: string; imageId: string }>("VIEWER", async ({ session, params }) => {
  const c = await conversationIn(session.workspaceId, params.id);
  if (!/^[0-9a-f-]{36}$/i.test(params.imageId)) notFound();
  const [m] = await db
    .select({ attachments: messages.attachments })
    .from(messages)
    .where(and(eq(messages.conversationId, c.id), sql`${messages.attachments} @> ${JSON.stringify([{ imageId: params.imageId }])}::jsonb`))
    .limit(1);
  const a = m?.attachments.find((x) => x.imageId === params.imageId);
  if (!a?.storagePath || !a.mime || !(a.mime in CHAT_IMAGE_TYPES)) notFound();
  // defence in depth: only files under this workspace's upload folder
  const root = path.resolve(serverEnv.storageDir, "uploads", session.workspaceId) + path.sep;
  if (!path.resolve(a.storagePath).startsWith(root)) notFound();
  const bytes = await readFile(a.storagePath).catch(() => null);
  if (!bytes) notFound();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": a.mime,
      "content-disposition": `inline; filename="${encodeURIComponent(a.name)}"`,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
});
