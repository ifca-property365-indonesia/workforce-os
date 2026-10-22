import { MEMORY_PREVIEW_TTL_S, memoryPreviewKey, type MemoryPreviewItem, type MiscJob } from "@wfos/shared";
import { env } from "../lib/env";
import { redis } from "../lib/redis";
import { recallMemories } from "./prompt";

/**
 * Memory preview (after OpenHuman's pack preview): what recallMemories would give the employee for this brief, left
 * in Redis for the web to show. A preview is not a use (countUse false).
 */
export async function previewMemories(job: Extract<MiscJob, { kind: "memory_preview" }>): Promise<void> {
  const mem = await recallMemories(job.employeeId, job.brief, job.clientId, { countUse: false });
  const items: MemoryPreviewItem[] = mem.flatMap((m) => (m.id ? [{ id: m.id, kind: m.kind ?? "fact", content: m.content, untrusted: m.untrusted }] : []));
  await redis.set(memoryPreviewKey(env.namespace, job.requestId), JSON.stringify(items), "EX", MEMORY_PREVIEW_TTL_S);
}
