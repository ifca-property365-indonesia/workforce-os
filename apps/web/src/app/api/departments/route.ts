import { workspaceDepartments } from "@wfos/db";
import { route } from "@/lib/server/route";

export const GET = route("VIEWER", async ({ session }) => ({ departments: await workspaceDepartments(session.workspaceId) }));
