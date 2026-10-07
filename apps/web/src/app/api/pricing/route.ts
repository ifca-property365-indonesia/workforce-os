import { z } from "zod";
import { audit, db, modelPrices } from "@wfos/db";
import { BUILTIN_TOOLS, CREDIT_USD } from "@wfos/shared";
import { body, route } from "@/lib/server/route";

/** Published price table: credits per model per 1K tokens and per tool call. */
export const GET = route("VIEWER", async () => {
  const models = await db.select().from(modelPrices).orderBy(modelPrices.inputPer1k);
  return { creditUsd: CREDIT_USD, models, tools: BUILTIN_TOOLS.map((t) => ({ name: t.name, label: t.label, class: t.class, credits: t.credits })) };
});

const schema = z.object({
  model: z.string().min(3),
  label: z.string().min(1),
  inputPer1k: z.number().nonnegative(),
  outputPer1k: z.number().nonnegative(),
  cacheReadPer1k: z.number().nonnegative().default(0),
  cacheWritePer1k: z.number().nonnegative().default(0),
});

// Prices are platform-wide; only Owners can change them.
export const PUT = route("OWNER", async ({ session, req }) => {
  const input = await body(req, schema);
  await db.insert(modelPrices).values(input).onConflictDoUpdate({ target: modelPrices.model, set: input });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "pricing.updated", targetType: "model_price", targetId: input.model, details: input });
  return { ok: true };
});
