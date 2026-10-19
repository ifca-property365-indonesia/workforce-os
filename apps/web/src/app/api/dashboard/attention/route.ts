import { attention } from "@/lib/server/attention";
import { route } from "@/lib/server/route";

/** The home page's "needs attention" card (see lib/server/attention). */
export const GET = route("VIEWER", async ({ session }) => attention(session.workspaceId));
