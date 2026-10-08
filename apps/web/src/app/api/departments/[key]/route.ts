import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, departments, workspaceDepartments } from "@wfos/db";
import { WORKSPACE_BUILTIN_TOOLS } from "@wfos/shared";
import { body, notFound, route } from "@/lib/server/route";

const bilingual = (max: number) => z.object({ en: z.string().trim().max(max), id: z.string().trim().max(max) });
const schema = z.object({
  name: z.object({ en: z.string().trim().min(1).max(60), id: z.string().trim().min(1).max(60) }),
  sop: bilingual(20_000),
  subagents: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]{1,30}$/, "lowercase letters, digits and dashes"),
        description: bilingual(500),
        prompt: bilingual(8000),
        tools: z.array(z.enum(WORKSPACE_BUILTIN_TOOLS)).max(20).optional(),
      }),
    )
    .max(10)
    .refine((a) => new Set(a.map((x) => x.name)).size === a.length, "subagent names must be unique"),
});

/** Edit a department's SOP and subagents (they apply to every employee in it from the next run). */
export const PUT = route<{ key: string }>("ADMIN", async ({ session, req, params }) => {
  const input = await body(req, schema);
  await workspaceDepartments(session.workspaceId);
  const [d] = await db
    .update(departments)
    .set(input)
    .where(and(eq(departments.workspaceId, session.workspaceId), eq(departments.key, params.key)))
    .returning();
  if (!d) notFound("department_not_found");
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: "department.updated",
    targetType: "department",
    targetId: params.key,
    details: { subagents: input.subagents.map((s) => s.name) },
  });
  return { department: d };
});
