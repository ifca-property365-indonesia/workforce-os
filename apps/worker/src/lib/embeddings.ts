import path from "node:path";
import { EMBEDDING_DIM } from "@wfos/db";
import { env } from "./env";
import { log } from "./logger";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = path.join(env.storageDir, "models");
      t.env.allowLocalModels = true;
      const pipe = await t.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
      log.info("embedding model loaded (all-MiniLM-L6-v2, 384d)");
      return pipe as unknown as Extractor;
    })().catch((e) => {
      extractorPromise = null;
      throw e;
    });
  }
  return extractorPromise;
}

/** Local embeddings: no data leaves the server. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ex = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 2000));
    const res = await ex(batch, { pooling: "mean", normalize: true });
    out.push(...res.tolist());
  }
  for (const v of out) if (v.length !== EMBEDDING_DIM) throw new Error(`embedding dim ${v.length} != ${EMBEDDING_DIM}`);
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v!;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}
