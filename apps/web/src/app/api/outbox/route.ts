import { route } from "@/lib/server/route";
import { listOutbox, outboxStats, parseOutboxFilter } from "@/lib/server/outbox";

/** Every email employees sent or tried to send, merged with the email proposals still in (or refused by) the approvals inbox. */
export const GET = route("VIEWER", async ({ session, req }) => {
  const filter = parseOutboxFilter(req.nextUrl.searchParams);
  const [items, stats] = await Promise.all([listOutbox(session.workspaceId, filter), outboxStats(session.workspaceId)]);
  return { items, stats };
});
