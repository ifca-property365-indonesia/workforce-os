import { db, modelPrices } from "@wfos/db";
import { DEFAULT_MODEL_PRICES, type ModelPrice } from "@wfos/shared";

let cache: { at: number; map: Map<string, ModelPrice> } | null = null;

export async function priceFor(model: string): Promise<ModelPrice | undefined> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const rows = await db.select().from(modelPrices);
    const map = new Map<string, ModelPrice>(DEFAULT_MODEL_PRICES.map((p) => [p.model, p]));
    for (const r of rows) map.set(r.model, r);
    cache = { at: Date.now(), map };
  }
  // tolerate dated / suffixed variants reported by the API
  return cache.map.get(model) ?? [...cache.map.values()].find((p) => model.startsWith(p.model));
}
