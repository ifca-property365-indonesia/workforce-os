import { getDb } from "./index";
import { auditLog } from "./schema";

export async function audit(entry: {
  workspaceId: string;
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await getDb().insert(auditLog).values({
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    details: entry.details ?? {},
  });
}
