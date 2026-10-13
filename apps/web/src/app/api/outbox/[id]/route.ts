import { notFound, route } from "@/lib/server/route";
import { getOutboxItem } from "@/lib/server/outbox";

export const GET = route<{ id: string }>("VIEWER", async ({ session, params }) => {
  const item = await getOutboxItem(session.workspaceId, params.id);
  if (!item) notFound("outbox_not_found");
  return { item };
});
