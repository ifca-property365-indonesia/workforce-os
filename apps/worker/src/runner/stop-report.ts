import { and, desc, eq, notLike } from "drizzle-orm";
import { db, steps, tasks } from "@wfos/db";
import { msg } from "@wfos/shared/messages";
import { redactSecrets } from "@wfos/shared/server";
import { log } from "../lib/logger";
import { workspaceLocale } from "../lib/settings";
import type { FailureKind } from "./incidents";

/**
 * A run the platform stopped (it looped, stalled, ran out of time or memory) never ends in silence (after OpenHuman's
 * "Incomplete" root-cause summaries): the failure carries a short report of where it was. Built from the record only,
 * with no model call: the last progress the employee reported, its last actions with their outcome, and how many
 * deliverables it left. The progress note and error excerpts come from the run (which may have read untrusted
 * content): they are cut and redacted, and prompts quote incident summaries as data (incidentBlock).
 */

/** the failures that are the platform stopping a run, not the run reporting an error */
export const FORCED_STOPS: readonly FailureKind[] = ["stalled", "loop", "time_limit", "out_of_memory"];
const LAST_ACTIONS = 6;
const ERROR_CHARS = 160;

function outcome(status: string, output: unknown): string {
  if (status === "ok") return "ok";
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  const err = typeof o?.error === "string" ? o.error : typeof output === "string" ? output : "";
  const line = redactSecrets(err).replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS);
  return line ? `${status}: ${line}` : status;
}

/** The report for a task the platform is stopping; "" when there is nothing to say or it cannot be built. */
export async function stopReport(taskId: string): Promise<string> {
  try {
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!t) return "";
    const locale = await workspaceLocale(t.workspaceId);
    const rows = await db
      .select({ name: steps.name, status: steps.status, output: steps.output })
      .from(steps)
      .where(and(eq(steps.taskId, taskId), eq(steps.kind, "tool"), notLike(steps.name, "gate:%")))
      .orderBy(desc(steps.createdAt))
      .limit(LAST_ACTIONS);
    const lines: string[] = [msg(locale, "stop.title")];
    if (t.progress != null) lines.push(msg(locale, "stop.progress", { percent: String(t.progress), note: t.progressNote ?? "" }).trim());
    lines.push(
      rows.length
        ? `${msg(locale, "stop.lastActions")}\n${rows
            .reverse()
            .map((r) => `- ${r.name} (${outcome(r.status, r.output)})`)
            .join("\n")}`
        : msg(locale, "stop.noActions"),
    );
    lines.push(msg(locale, "stop.deliverables", { count: String(t.deliverables.length) }));
    return lines.join("\n");
  } catch (e) {
    log.warn({ err: e, taskId }, "stop report not built");
    return "";
  }
}
