import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, documents } from "@wfos/db";
import { HttpError } from "./auth";
import { serverEnv } from "./env";
import { q } from "./queue";

const ALLOWED = [".pdf", ".docx", ".md", ".markdown", ".txt", ".csv", ".json"];
const MAX = 20 * 1024 * 1024;

/** Store an uploaded file and queue it for chunking + embedding. */
export async function saveDocument(workspaceId: string, userId: string, file: File) {
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED.includes(ext)) throw new HttpError(400, `Unsupported file type ${ext}`, { code: "unsupported_file_type", ext, allowed: ALLOWED.join(", ") });
  if (file.size > MAX) throw new HttpError(413, "File too large (max 20 MB)", { code: "file_too_large", max: 20 });
  const dir = path.resolve(serverEnv.storageDir, "uploads", workspaceId);
  await mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${randomUUID()}${ext}`);
  await writeFile(storagePath, Buffer.from(await file.arrayBuffer()));
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId, name: file.name.slice(0, 200), mime: file.type || "application/octet-stream", size: file.size, storagePath, uploadedBy: userId })
    .returning();
  await q.ingest(doc!.id, workspaceId);
  return doc!;
}
