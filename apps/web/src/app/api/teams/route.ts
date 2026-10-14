import { jsonObject, route } from "@/lib/server/route";
import { listDivisions, saveDivision } from "@/lib/server/teams";

/** Divisions (UI "Divisi") in org-chart order: members with their role, workload and 7-day credits. */
export const GET = route("VIEWER", async ({ session }) => ({ teams: await listDivisions(session.workspaceId) }));

/** Create a division (Owner/Admin). `move: true` moves people who are in another division instead of a 409. */
export const POST = route("ADMIN", async ({ session, req }) => {
  const raw = await jsonObject(req);
  return { team: await saveDivision(session, raw, { move: raw.move === true }) };
});
