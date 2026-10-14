import { HttpError } from "@/lib/server/auth";
import { loadAppEnv } from "@/lib/server/apps";
import { route } from "@/lib/server/route";
import { UPTIME_RANGES, uptimeReport, type UptimeRange } from "@/lib/server/uptime";

/**
 * The uptime of an environment (`?env=live`; a preview is never checked, so it reports nothing) over the last
 * `days` (1, 7 or 30; default 1): status, uptime %, the checks in buckets and the incidents. Anyone in the workspace.
 */
export const GET = route<{ id: string }>("VIEWER", async ({ session, req, params }) => {
  const raw = req.nextUrl.searchParams.get("days") ?? "1";
  const days = Number(raw) as UptimeRange;
  if (!(UPTIME_RANGES as readonly number[]).includes(days) || String(days) !== raw) {
    throw new HttpError(400, "days must be 1, 7 or 30", { code: "uptime_days" });
  }
  const { env } = await loadAppEnv(session.workspaceId, params.id, req);
  return uptimeReport(session.workspaceId, env, days);
});
