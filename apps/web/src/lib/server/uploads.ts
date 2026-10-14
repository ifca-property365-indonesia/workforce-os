import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, documents } from "@wfos/db";
import { CHAT_ATTACHMENTS_MAX, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, type ChatImageType, type StoredChatAttachment } from "@wfos/shared";
import { HttpError } from "./auth";
import { serverEnv } from "./env";
import { q } from "./queue";

const ALLOWED = [".pdf", ".docx", ".md", ".markdown", ".txt", ".csv", ".json"];
const MAX = 20 * 1024 * 1024;

function checkDocument(file: File): string {
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED.includes(ext)) throw new HttpError(400, `Unsupported file type ${ext}`, { code: "unsupported_file_type", ext, allowed: ALLOWED.join(", ") });
  if (file.size > MAX) throw new HttpError(413, "File too large (max 20 MB)", { code: "file_too_large", max: 20 });
  return ext;
}

/**
 * Store an uploaded file and queue it for chunking + embedding. With `clientId` it is that client's knowledge: only
 * work for that client finds it.
 */
export async function saveDocument(workspaceId: string, userId: string, file: File, opts: { clientId?: string | null } = {}) {
  const ext = checkDocument(file);
  const dir = path.resolve(serverEnv.storageDir, "uploads", workspaceId);
  await mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${randomUUID()}${ext}`);
  await writeFile(storagePath, Buffer.from(await file.arrayBuffer()));
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId, name: file.name.slice(0, 200), mime: file.type || "application/octet-stream", size: file.size, storagePath, uploadedBy: userId, clientId: opts.clientId ?? null })
    .returning();
  await q.ingest(doc!.id, workspaceId);
  return doc!;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An image's type from its first bytes (never from the browser's claim), or null. */
export function sniffImage(b: Uint8Array): ChatImageType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** Whether an upload is meant as an image (declared type or name); its bytes decide whether it is accepted. */
export const isImageUpload = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name);

async function checkImage(file: File): Promise<{ bytes: Uint8Array; mime: ChatImageType }> {
  if (file.size > CHAT_IMAGE_MAX_BYTES) throw new HttpError(413, "Image too large (max 5 MB)", { code: "image_too_large", max: CHAT_IMAGE_MAX_BYTES / 1024 / 1024 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime) throw new HttpError(400, "Unsupported image type", { code: "unsupported_image_type", allowed: "PNG, JPEG, GIF, WebP" });
  return { bytes, mime };
}

/**
 * A chat message's new files, at most CHAT_ATTACHMENTS_MAX together with the `existing` ones. All are checked before
 * any is stored. Images are kept for the model to see (not indexed); documents go into the knowledge base.
 */
export async function saveChatAttachments(workspaceId: string, userId: string, files: File[], existing = 0): Promise<StoredChatAttachment[]> {
  const take = files.slice(0, Math.max(0, CHAT_ATTACHMENTS_MAX - existing));
  const checked = await Promise.all(take.map(async (f) => (isImageUpload(f) ? { f, image: await checkImage(f) } : (checkDocument(f), { f, image: null }))));
  const out: StoredChatAttachment[] = [];
  for (const { f, image } of checked) {
    if (!image) {
      const doc = await saveDocument(workspaceId, userId, f);
      out.push({ name: doc.name, size: doc.size, documentId: doc.id });
      continue;
    }
    const imageId = randomUUID();
    const ext = CHAT_IMAGE_TYPES[image.mime];
    const dir = path.resolve(serverEnv.storageDir, "uploads", workspaceId, "chat-images");
    await mkdir(dir, { recursive: true });
    const storagePath = path.join(dir, `${imageId}${ext}`);
    await writeFile(storagePath, image.bytes);
    out.push({ name: f.name.slice(0, 200) || `image${ext}`, size: f.size, mime: image.mime, imageId, storagePath });
  }
  return out;
}
