import "server-only";
import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { appReleases, apps, clients, db, projects, repositories, servers, users, workspaces } from "@wfos/db";
import { APP_PORT_MAX, APP_PORT_MIN, type AppDTO, type AppEnv, type ReleaseDTO } from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import { HttpError } from "./auth";
import { notFound } from "./route";

export type AppRow = typeof apps.$inferSelect;
export type ReleaseRow = typeof appReleases.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** releases a person still waits for: a second deploy of the same app is refused meanwhile */
export const ACTIVE_RELEASE_STATUSES = ["queued", "deploying"] as const;
/** releases whose commit can be brought back */
export const ROLLBACK_SOURCE_STATUSES = ["deployed", "superseded"] as const;
/** how many releases the app page shows */
export const RELEASES_SHOWN = 30;

/** The decrypted extra env of an app ({} when none). Server side only: values never leave this module's callers. */
export function readEnv(envEnc: string | null): AppEnv {
  if (!envEnc) return {};
  try {
    const v = JSON.parse(decryptSecret(envEnc)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AppEnv) : {};
  } catch {
    return {};
  }
}

export function envKeys(envEnc: string | null): string[] {
  return Object.keys(readEnv(envEnc)).sort();
}

export function releaseDTO(r: ReleaseRow, createdByName: string | null): ReleaseDTO {
  return {
    id: r.id,
    appId: r.appId,
    commit: r.commit,
    branch: r.branch,
    commitSubject: r.commitSubject,
    status: r.status,
    trigger: r.trigger,
    step: r.step,
    warnings: r.warnings,
    error: r.error,
    approvalId: r.approvalId,
    taskId: r.taskId,
    createdByName,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** Releases with their creator's name (no log, no manifest, no backup name). */
export async function releasesWithNames(where: SQL | undefined, limit?: number): Promise<ReleaseDTO[]> {
  const q = db
    .select({ r: appReleases, by: users.name })
    .from(appReleases)
    .leftJoin(users, eq(users.id, appReleases.createdBy))
    .where(where)
    .orderBy(desc(appReleases.createdAt));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map((x) => releaseDTO(x.r, x.by));
}

/**
 * What the browser may see of an app: never the env values, the preview password, APP_SECRET or the database
 * password — only the env names and whether a database exists.
 */
export async function appDTOs(workspaceId: string, ids?: string[]): Promise<AppDTO[]> {
  if (ids && !ids.length) return [];
  const rows = await db
    .select({ a: apps, serverName: servers.name, repositoryName: repositories.name })
    .from(apps)
    .innerJoin(servers, eq(servers.id, apps.serverId))
    .leftJoin(repositories, eq(repositories.id, apps.repositoryId))
    .where(ids ? and(eq(apps.workspaceId, workspaceId), inArray(apps.id, ids)) : eq(apps.workspaceId, workspaceId))
    .orderBy(apps.name);
  const currentIds = rows.map((r) => r.a.currentReleaseId).filter((x): x is string => !!x);
  const current = currentIds.length
    ? await db
        .select({ r: appReleases, by: users.name })
        .from(appReleases)
        .leftJoin(users, eq(users.id, appReleases.createdBy))
        .where(and(eq(appReleases.workspaceId, workspaceId), inArray(appReleases.id, currentIds)))
    : [];
  const byId = new Map(current.map((x) => [x.r.id, x]));
  return rows.map(({ a, serverName, repositoryName }) => {
    const cur = a.currentReleaseId ? byId.get(a.currentReleaseId) : undefined;
    return {
      id: a.id,
      name: a.name,
      slug: a.slug,
      url: `https://${a.domain}`,
      serverId: a.serverId,
      serverName,
      repositoryId: a.repositoryId,
      repositoryName: repositoryName ?? null,
      branch: a.branch,
      clientId: a.clientId,
      projectId: a.projectId,
      port: a.port,
      status: a.status,
      statusMessage: a.statusMessage,
      accessMode: a.accessMode,
      envKeys: envKeys(a.envEnc),
      hasDatabase: !!a.dbPasswordEnc || !!cur?.r.manifest?.database,
      memoryMb: a.memoryMb,
      healthy: a.healthy,
      lastHealthAt: a.lastHealthAt?.toISOString() ?? null,
      lastDeployedAt: a.lastDeployedAt?.toISOString() ?? null,
      currentRelease: cur ? releaseDTO(cur.r, cur.by) : null,
      createdAt: a.createdAt.toISOString(),
    };
  });
}

export async function appDTO(workspaceId: string, id: string): Promise<AppDTO> {
  const [dto] = await appDTOs(workspaceId, [id]);
  if (!dto) notFound("app_not_found");
  return dto;
}

export async function loadApp(workspaceId: string, id: string): Promise<AppRow> {
  if (!isUuid(id)) notFound("app_not_found");
  const [a] = await db.select().from(apps).where(and(eq(apps.id, id), eq(apps.workspaceId, workspaceId)));
  if (!a) notFound("app_not_found");
  return a;
}

/**
 * Deploys, rollbacks and starts are irreversible actions on a real server: refused while the workspace kill switch
 * is engaged, and in demo mode (the workspace's dry run: nothing leaves the platform).
 */
export async function assertDeploysAllowed(workspaceId: string) {
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch, demoMode: workspaces.demoMode }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (ws?.killSwitch) throw new HttpError(409, "The kill switch is engaged", { code: "apps_kill_switch" });
  if (ws?.demoMode) throw new HttpError(409, "Demo mode is on", { code: "apps_demo_mode" });
}

/** the lowest port of APP_PORT_MIN..APP_PORT_MAX not taken on this server, or null when the range is full */
export async function lowestFreePort(serverId: string): Promise<number | null> {
  const used = new Set((await db.select({ port: apps.port }).from(apps).where(eq(apps.serverId, serverId))).map((r) => r.port));
  for (let p = APP_PORT_MIN; p <= APP_PORT_MAX; p++) if (!used.has(p)) return p;
  return null;
}

/** A unique-index violation as the 409 the form shows; "port" for a lost port race (the caller tries the next one). */
export function appDuplicate(e: unknown): HttpError | "port" | null {
  const err = (e as { cause?: unknown })?.cause ?? e;
  const pg = err as { code?: string; constraint_name?: string };
  if (pg?.code !== "23505") return null;
  if (pg.constraint_name === "apps_server_port") return "port";
  if (pg.constraint_name === "apps_ws_name") return new HttpError(409, "An app with this name already exists", { code: "app_name_taken" });
  return new HttpError(409, "This address is taken", { code: "app_slug_taken" });
}

/** 16 characters without look-alikes (no 0/O, 1/l/I): read from a screen and typed into a browser prompt */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePreviewPassword(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/** the basic-auth user of every preview */
export const PREVIEW_USER = "preview";

/** Does the app have a release a person is waiting for? */
export async function activeRelease(appId: string, tx: Pick<typeof db, "select"> = db) {
  const [r] = await tx
    .select({ id: appReleases.id })
    .from(appReleases)
    .where(and(eq(appReleases.appId, appId), inArray(appReleases.status, [...ACTIVE_RELEASE_STATUSES])))
    .limit(1);
  return r ?? null;
}

/** a client and project of this workspace (the project's client when only the project is given) */
export async function resolveClientProject(workspaceId: string, clientId: string | null | undefined, projectId: string | null | undefined) {
  let client = clientId ?? null;
  if (projectId) {
    const [p] = await db.select({ clientId: projects.clientId }).from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (!p) throw new HttpError(400, "Unknown project", { code: "unknown_project" });
    if (client && client !== p.clientId) throw new HttpError(400, "The project belongs to another client", { code: "app_project_client_mismatch" });
    client = p.clientId;
  }
  if (client) {
    const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, client), eq(clients.workspaceId, workspaceId)));
    if (!c) throw new HttpError(400, "Unknown client", { code: "unknown_client" });
  }
  return { clientId: client, projectId: projectId ?? null };
}
