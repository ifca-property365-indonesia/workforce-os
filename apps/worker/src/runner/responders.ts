import { asc, eq, inArray } from "drizzle-orm";
import { db, employees, teamMembers, type conversations, type messages, type teams } from "@wfos/db";
import { MAX_RESPONDERS_PER_TURN, type RoutedBy } from "@wfos/shared";
import { checkBudget } from "../guards/budget";
import { getWorkspace } from "../lib/settings";
import { activeQuotaPause } from "../lib/limits";
import { classifyResponder, ROUTE_EVERYONE, type RouteDecision } from "./route-classifier";

type Conversation = typeof conversations.$inferSelect;
type Team = typeof teams.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
export type TeamMember = typeof employees.$inferSelect;

/**
 * At most this many members answer one turn (everyone / @semua / classifier "__everyone__" / many
 * mentions); the lead, when among them, always comes first. The rest are reported as `skipped`.
 */
export { MAX_RESPONDERS_PER_TURN };

export type ResponderResolution = { responders: string[]; routedBy: RoutedBy; skipped?: string[] } | { responders: []; hint: "no_responder" };

/** Same resolution before the classifier ran: "auto" means it still has to. */
export type StaticResolution = ResponderResolution | { auto: true };

/** The team's members (lead included even if missing from team_members), lead first, then in the order they were hired. */
export async function loadTeamMembers(team: Team): Promise<TeamMember[]> {
  const ids = (await db.select({ id: teamMembers.employeeId }).from(teamMembers).where(eq(teamMembers.teamId, team.id))).map((r) => r.id);
  if (team.leadId && !ids.includes(team.leadId)) ids.push(team.leadId);
  if (!ids.length) return [];
  const rows = await db.select().from(employees).where(inArray(employees.id, ids)).orderBy(asc(employees.createdAt), asc(employees.id));
  return [...rows.filter((e) => e.id === team.leadId), ...rows.filter((e) => e.id !== team.leadId)];
}

/**
 * Who answers when nobody in particular is addressed: the lead if active, else the first active
 * member, else the (inactive) lead or first member, whose reply then explains why they cannot answer.
 */
export function defaultResponder(team: Team, members: TeamMember[]): TeamMember | null {
  const lead = members.find((m) => m.id === team.leadId) ?? null;
  if (lead?.status === "ACTIVE") return lead;
  return members.find((m) => m.status === "ACTIVE") ?? lead ?? members[0] ?? null;
}

/** Lead first, then the given order; cut at MAX_RESPONDERS_PER_TURN. */
function capped(team: Team, ids: string[], routedBy: RoutedBy): ResponderResolution {
  const ordered = team.leadId && ids.includes(team.leadId) ? [team.leadId, ...ids.filter((id) => id !== team.leadId)] : ids;
  const responders = ordered.slice(0, MAX_RESPONDERS_PER_TURN);
  const skipped = ordered.slice(MAX_RESPONDERS_PER_TURN);
  return skipped.length ? { responders, routedBy, skipped } : { responders, routedBy };
}

function leadRoute(team: Team, members: TeamMember[]): ResponderResolution {
  const d = defaultResponder(team, members);
  if (!d) return { responders: [], hint: "no_responder" };
  return { responders: [d.id], routedBy: d.id === team.leadId ? { mode: "lead" } : { mode: "fallback", reason: "lead_unavailable" } };
}

function everyoneRoute(team: Team, members: TeamMember[], routedBy: RoutedBy): ResponderResolution {
  const active = members.filter((m) => m.status === "ACTIVE");
  if (!active.length) return leadRoute(team, members);
  return capped(team, active.map((m) => m.id), routedBy);
}

/**
 * Everything but the classifier, so it can run inside the claim transaction:
 * @mentions (union over the turn, in member order) → @semua → the team's responder mode.
 * Only ACTIVE employees answer; when every mentioned member is inactive, the first of them still
 * gets the turn so the reply explains they cannot answer (as a 1:1 chat with them would).
 */
export function resolveStatic(team: Team, claimed: MessageRow[], members: TeamMember[]): StaticResolution {
  const mentioned = new Set(claimed.flatMap((m) => m.meta.mentions ?? []));
  const named = members.filter((m) => mentioned.has(m.id));
  if (named.length) {
    const active = named.filter((m) => m.status === "ACTIVE");
    return capped(team, (active.length ? active : [named[0]!]).map((m) => m.id), { mode: "mention" });
  }
  if (claimed.some((m) => m.meta.mentionAll)) return everyoneRoute(team, members, { mode: "everyone" });
  switch (team.responderMode) {
    case "everyone":
      return everyoneRoute(team, members, { mode: "everyone" });
    case "mentions":
      return { responders: [], hint: "no_responder" };
    case "auto":
      return { auto: true };
    case "lead":
    default:
      return leadRoute(team, members);
  }
}

/**
 * Pick the responders of a team-chat turn. 1:1 conversations always have their one employee.
 * "auto" asks the routing classifier (skipped when the kill switch is engaged, the default
 * responder's budget is spent, in Demo Mode, while the workspace is paused on the Claude
 * subscription limit, or when only one member could answer); any
 * classifier failure falls back to the default responder with routedBy {mode:"fallback", reason}.
 */
export async function resolveResponders(
  conv: Conversation,
  team: Team | null,
  claimed: MessageRow[],
  members: TeamMember[],
  opts: { recentTranscript?: () => Promise<string>; classify?: typeof classifyResponder } = {},
): Promise<ResponderResolution> {
  if (conv.employeeId || !team) return conv.employeeId ? { responders: [conv.employeeId], routedBy: { mode: "lead" } } : { responders: [], hint: "no_responder" };
  const r = resolveStatic(team, claimed, members);
  if (!("auto" in r)) return r;

  const fallback = (reason: string): ResponderResolution => {
    const d = defaultResponder(team, members);
    return d ? { responders: [d.id], routedBy: { mode: "fallback", reason } } : { responders: [], hint: "no_responder" };
  };
  const active = members.filter((m) => m.status === "ACTIVE");
  if (active.length <= 1) return leadRoute(team, members);
  const chargeTo = defaultResponder(team, members)!;
  const ws = await getWorkspace(conv.workspaceId);
  if (ws.killSwitch) return fallback("killswitch");
  if (ws.demoMode) return fallback("demo");
  // the subscription refuses work until the reset: the classifier call would only be rejected too
  if (await activeQuotaPause(ws.id)) return fallback("quota");
  if (!(await checkBudget(ws.id, chargeTo.id)).ok) return fallback("budget");

  const decision: RouteDecision = await (opts.classify ?? classifyResponder)({
    workspaceId: conv.workspaceId,
    conversationId: conv.id,
    members: active.map((m) => ({ id: m.id, name: m.name, role: m.role })),
    recentTranscript: opts.recentTranscript ? await opts.recentTranscript() : "",
    newMessage: claimed.map((m) => m.content).join("\n\n"),
    employeeId: chargeTo.id,
  });
  if ("fallback" in decision) return fallback(decision.fallback);
  if (decision.pick === ROUTE_EVERYONE) return everyoneRoute(team, members, { mode: "auto", confidence: decision.confidence });
  return { responders: [decision.pick], routedBy: { mode: "auto", confidence: decision.confidence } };
}
