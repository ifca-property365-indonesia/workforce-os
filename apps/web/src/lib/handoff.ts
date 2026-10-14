/**
 * A PRD handoff approval's payload, old and new: since divisions it names the division (teamId/teamName) that builds
 * the PRD; payloads made before name a developer (developerId/developerName) and must still read correctly.
 */
export interface HandoffPayload {
  title?: string;
  prd?: string;
  teamId?: string | null;
  teamName?: string | null;
  developerId?: string | null;
  developerName?: string | null;
  repositoryId?: string | null;
  resumeTaskId?: string | null;
}

/** where an approved PRD goes: a division, a developer (older payloads), or nobody chosen yet */
export type HandoffTarget = { kind: "division"; name: string } | { kind: "developer"; name: string } | { kind: "none" };

export function handoffTarget(p: HandoffPayload): HandoffTarget {
  if (p.teamName) return { kind: "division", name: p.teamName };
  if (p.developerName) return { kind: "developer", name: p.developerName };
  return { kind: "none" };
}

/** the fields Edit & Approve may change; an older payload keeps its developer and gains a division choice */
export function handoffPick(p: HandoffPayload): { teamId?: string | null; developerId?: string | null; repositoryId: string | null } {
  return {
    ...("teamId" in p || !("developerId" in p) ? { teamId: p.teamId ?? null } : {}),
    ...("developerId" in p ? { developerId: p.developerId ?? null } : {}),
    repositoryId: p.repositoryId ?? null,
  };
}
