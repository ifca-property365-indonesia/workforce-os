import { z } from "zod";
import { body, route } from "@/lib/server/route";
import { applySkillUpdate, skillUpdatePreview } from "@/lib/server/skill-catalog";

type P = { id: string };

/** C4: the installed version of a catalog skill and its newer commit, to compare before applying. */
export const GET = route<P>("ADMIN", async ({ session, params }) => skillUpdatePreview(session.workspaceId, params.id));

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const applySchema = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/), contentHash: sha256, filesHash: sha256 });

/** Apply exactly the version that was read (its commit, SKILL.md hash and files hash). */
export const POST = route<P>("ADMIN", async ({ session, req, params }) => applySkillUpdate(session, params.id, await body(req, applySchema)));
