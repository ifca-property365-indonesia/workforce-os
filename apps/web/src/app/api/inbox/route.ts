import { route } from "@/lib/server/route";
import { inboxFor } from "@/lib/server/inbox";

/** "Needs a decision": what waits for a person besides approval cards, and the counts the menu bar and dock show. */
export const GET = route("VIEWER", async ({ session }) => inboxFor(session.workspaceId));
