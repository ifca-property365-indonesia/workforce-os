import { ROLE_TEMPLATES } from "@wfos/templates";
import { BUILTIN_TOOLS } from "@wfos/shared";
import { route } from "@/lib/server/route";

export const GET = route("VIEWER", async () => ({ templates: ROLE_TEMPLATES, tools: BUILTIN_TOOLS }));
