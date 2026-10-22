import { and, eq, inArray } from "drizzle-orm";
import { db, memories } from "@wfos/db";
import { route } from "@/lib/server/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Memories by id (at most 20), this workspace's only: the chip under a chat reply lists the memories it used. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .filter((x) => UUID.test(x))
    .slice(0, 20);
  if (!ids.length) return { memories: [] };
  const rows = await db
    .select({ id: memories.id, kind: memories.kind, content: memories.content, employeeId: memories.employeeId, untrusted: memories.untrusted })
    .from(memories)
    .where(and(eq(memories.workspaceId, session.workspaceId), inArray(memories.id, ids)));
  return { memories: rows };
});
