import { and, desc, eq, lt } from "drizzle-orm";
import { auditLog, db } from "@wfos/db";
import { route } from "@/lib/server/route";

export const GET = route("ADMIN", async ({ session, req }) => {
  const before = req.nextUrl.searchParams.get("before");
  const rows = await db
    .select()
    .from(auditLog)
    .where(before ? and(eq(auditLog.workspaceId, session.workspaceId), lt(auditLog.createdAt, new Date(before))) : eq(auditLog.workspaceId, session.workspaceId))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);
  return { entries: rows };
});
