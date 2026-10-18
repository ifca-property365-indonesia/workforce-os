import "server-only";
import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { apps, clients, db, documents, employees, tasks, teams } from "@wfos/db";
import type { TaskStatus } from "@wfos/shared";

/**
 * Ctrl+K search over one workspace. Tasks (the only table that grows without bound) use Postgres full-text search on
 * the GIN index of migration 0033; the small tables (employees, divisions, clients, apps, documents) match names.
 * Every query is filtered by the workspace first.
 */

const PER_GROUP = 6;
const TERMS_MAX = 6;
/** shortest query the server searches (one letter matches half the workspace) */
export const SEARCH_MIN_CHARS = 2;

/**
 * The words of a query as a prefix tsquery for the 'simple' configuration: "buku tam" → "buku:* & tam:*". Only letters
 * and digits survive, so the result is always a valid tsquery (no operators from the user). null: nothing to search.
 */
export function prefixTsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, TERMS_MAX);
  return words.length ? words.map((w) => `${w}:*`).join(" & ") : null;
}

/** LIKE pattern for a name match: the query's own % and _ are matched literally */
export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** must stay the expression of the tasks_search index (migration 0033), or Postgres cannot use it */
const taskVector = sql`to_tsvector('simple', coalesce(${tasks.title}, '') || ' ' || coalesce(${tasks.brief}, ''))`;

export interface SearchResults {
  tasks: { id: string; title: string; status: TaskStatus }[];
  employees: { id: string; name: string; role: string }[];
  divisions: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  apps: { id: string; name: string; slug: string }[];
  documents: { id: string; name: string }[];
}

export async function searchWorkspace(workspaceId: string, q: string): Promise<SearchResults> {
  const ts = prefixTsQuery(q);
  const like = likePattern(q);
  if (!ts || q.trim().length < SEARCH_MIN_CHARS) return { tasks: [], employees: [], divisions: [], clients: [], apps: [], documents: [] };
  const query = sql`to_tsquery('simple', ${ts})`;
  const [taskRows, empRows, divRows, clientRows, appRows, docRows] = await Promise.all([
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), sql`${taskVector} @@ ${query}`))
      // best match first, then the newest
      .orderBy(desc(sql`ts_rank(${taskVector}, ${query})`), desc(tasks.createdAt))
      .limit(PER_GROUP),
    db
      .select({ id: employees.id, name: employees.name, role: employees.role })
      .from(employees)
      .where(and(eq(employees.workspaceId, workspaceId), ne(employees.status, "ARCHIVED"), or(ilike(employees.name, like), ilike(employees.role, like))))
      .orderBy(employees.name)
      .limit(PER_GROUP),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), ilike(teams.name, like)))
      .orderBy(teams.name)
      .limit(PER_GROUP),
    db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.workspaceId, workspaceId), ilike(clients.name, like)))
      .orderBy(clients.name)
      .limit(PER_GROUP),
    db
      .select({ id: apps.id, name: apps.name, slug: apps.slug })
      .from(apps)
      .where(and(eq(apps.workspaceId, workspaceId), or(ilike(apps.name, like), ilike(apps.slug, like))))
      .orderBy(apps.name)
      .limit(PER_GROUP),
    db
      .select({ id: documents.id, name: documents.name })
      .from(documents)
      .where(and(eq(documents.workspaceId, workspaceId), ilike(documents.name, like)))
      .orderBy(desc(documents.createdAt))
      .limit(PER_GROUP),
  ]);
  return { tasks: taskRows, employees: empRows, divisions: divRows, clients: clientRows, apps: appRows, documents: docRows };
}
