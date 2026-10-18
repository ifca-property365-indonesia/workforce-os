import { route } from "@/lib/server/route";
import { searchWorkspace } from "@/lib/server/search";

/** Ctrl+K: tasks, employees, divisions, clients, apps and documents of this workspace matching `q`. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  return searchWorkspace(session.workspaceId, q);
});
