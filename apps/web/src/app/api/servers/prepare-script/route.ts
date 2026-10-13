import { notFound, route } from "@/lib/server/route";
import { readPrepareFiles } from "@/lib/server/servers";

/** prepare.sh and wfos-app-helper as they ship with this version, for the Owner to copy to a server. */
export const GET = route("ADMIN", async () => {
  const files = await readPrepareFiles();
  if (!files) notFound("prepare_script_missing");
  return { files };
});
