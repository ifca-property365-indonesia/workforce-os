import { jsonObject, route } from "@/lib/server/route";
import { deleteDivision, saveDivision } from "@/lib/server/teams";

type P = { id: string };

/**
 * Change a division (Owner/Admin). The body is merged over the stored division and the whole structure is validated:
 * head and code lead are members, subagents need a code lead, one division per employee (409 unless `move: true`).
 */
export const PATCH = route<P>("ADMIN", async ({ session, req, params }) => {
  const raw = await jsonObject(req);
  return { team: await saveDivision(session, raw, { id: params.id, move: raw.move === true }) };
});

export const DELETE = route<P>("ADMIN", async ({ session, params }) => {
  await deleteDivision(session, params.id);
  return { ok: true };
});
