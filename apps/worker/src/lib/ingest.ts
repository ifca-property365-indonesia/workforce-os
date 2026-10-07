import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { chunks, db, documents } from "@wfos/db";
import { embed } from "./embeddings";
import { log } from "./logger";

async function extractText(path: string, mime: string, name: string): Promise<string> {
  const buf = await readFile(path);
  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const r = await parser.getText();
      return r.text;
    } finally {
      await parser.destroy();
    }
  }
  if (name.toLowerCase().endsWith(".docx") || mime.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value;
  }
  return buf.toString("utf8");
}

/** Paragraph-aware chunking (~1200 chars, 200 overlap). */
export function chunkText(text: string, size = 1200, overlap = 200): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size && cur) {
      out.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap));
    }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size - overlap) out.push(p.slice(i, i + size));
      cur = "";
    } else {
      cur += (cur ? "\n\n" : "") + p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export async function ingestDocument(documentId: string): Promise<void> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return;
  try {
    const text = await extractText(doc.storagePath, doc.mime, doc.name);
    const parts = chunkText(text);
    const vecs = await embed(parts);
    await db.delete(chunks).where(eq(chunks.documentId, doc.id));
    for (let i = 0; i < parts.length; i += 50) {
      await db.insert(chunks).values(
        parts.slice(i, i + 50).map((content, j) => ({ workspaceId: doc.workspaceId, documentId: doc.id, ordinal: i + j, content, embedding: vecs[i + j]! })),
      );
    }
    await db.update(documents).set({ status: "indexed", chunkCount: parts.length, error: null }).where(eq(documents.id, doc.id));
    log.info({ documentId, chunks: parts.length }, "document indexed");
  } catch (e) {
    await db.update(documents).set({ status: "failed", error: (e as Error).message }).where(eq(documents.id, doc.id));
    throw e;
  }
}
