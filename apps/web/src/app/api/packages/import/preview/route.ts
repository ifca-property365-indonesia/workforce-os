import { route } from "@/lib/server/route";
import { previewImport, readPackage } from "@/lib/server/packages";

/** Validate a package and say what an import would create, warn about and clash with. Changes nothing. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const pkg = await readPackage(req);
  return { preview: await previewImport(session.workspaceId, pkg) };
});
