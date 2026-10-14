import "server-only";
import { randomInt } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull, max, ne, or, sql, type SQL } from "drizzle-orm";
import { appBackups, appEnvironments, appReleases, apps, auditLog, clients, db, employees, projects, repositories, servers, tasks, users, workspaces } from "@wfos/db";
import {
  APP_PORT_MAX,
  APP_PORT_MIN,
  appRemoveLockKey,
  type AppBackupDTO,
  type AppDTO,
  type AppEnv,
  type AppEnvironmentDTO,
  type AppEnvironmentKind,
  type AppManifest,
  type ReleaseDTO,
} from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import { HttpError, type Session } from "./auth";
import { serverEnv } from "./env";
import { pendingDbJobs, redis } from "./queue";
import { requireStepUp } from "./twofactor";
import type { ReleaseDbPlan, ReleaseOrigin, TaskPreview } from "@/lib/app-previews";
import { notFound } from "./route";

export type AppRow = typeof apps.$inferSelect;
export type ReleaseRow = typeof appReleases.$inferSelect;
export type EnvRow = typeof appEnvironments.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** releases a person still waits for: a second deploy of the same environment is refused meanwhile */
export const ACTIVE_RELEASE_STATUSES = ["queued", "deploying"] as const;
/** releases whose commit can be brought back */
export const ROLLBACK_SOURCE_STATUSES = ["deployed", "superseded"] as const;
/** how many releases the app page shows (per environment) */
export const RELEASES_SHOWN = 30;

/** The decrypted extra env of an environment ({} when none). Server side only: values never leave this module's callers. */
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

export function releaseDTO(r: ReleaseRow, createdByName: string | null, environmentKind: AppEnvironmentKind): ReleaseDTO {
  return {
    id: r.id,
    appId: r.appId,
    environmentId: r.environmentId,
    environmentKind,
    promotedFromReleaseId: r.promotedFromReleaseId,
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

/** Releases with their creator's name and environment (no log, no manifest, no backup name). */
export async function releasesWithNames(where: SQL | undefined, limit?: number): Promise<ReleaseDTO[]> {
  const q = db
    .select({ r: appReleases, by: users.name, kind: appEnvironments.kind })
    .from(appReleases)
    .innerJoin(appEnvironments, eq(appEnvironments.id, appReleases.environmentId))
    .leftJoin(users, eq(users.id, appReleases.createdBy))
    .where(where)
    .orderBy(desc(appReleases.createdAt));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map((x) => releaseDTO(x.r, x.by, x.kind));
}

/** The latest releases of each of the app's environments (RELEASES_SHOWN each), newest first. */
export async function appReleasesShown(workspaceId: string, appId: string): Promise<ReleaseDTO[]> {
  const envs = await db
    .select({ id: appEnvironments.id })
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.workspaceId, workspaceId)));
  const lists = await Promise.all(
    envs.map((e) => releasesWithNames(and(eq(appReleases.environmentId, e.id), eq(appReleases.workspaceId, workspaceId)), RELEASES_SHOWN)),
  );
  return lists.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * The previews a task published (releases it triggered through request_preview), newest first. Scoped twice to
 * the workspace: the release row and its app.
 */
export async function taskPreviews(workspaceId: string, taskId: string): Promise<TaskPreview[]> {
  const rows = await db
    .select({ r: appReleases, appName: apps.name, domain: appEnvironments.domain })
    .from(appReleases)
    .innerJoin(apps, eq(apps.id, appReleases.appId))
    .innerJoin(appEnvironments, eq(appEnvironments.id, appReleases.environmentId))
    .where(and(eq(appReleases.workspaceId, workspaceId), eq(apps.workspaceId, workspaceId), eq(appReleases.taskId, taskId)))
    .orderBy(desc(appReleases.createdAt))
    .limit(RELEASES_SHOWN);
  return rows.map(({ r, appName, domain }) => ({
    id: r.id,
    appId: r.appId,
    appName,
    status: r.status,
    step: r.step,
    commit: r.commit,
    commitSubject: r.commitSubject,
    warnings: r.warnings,
    error: r.error,
    approvalId: r.approvalId,
    url: r.status === "deployed" ? `https://${domain}` : null,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

/** The task and employee behind each release that came from a task, keyed by task id (tasks of this workspace only). */
export async function releaseOrigins(workspaceId: string, releases: Pick<ReleaseDTO, "taskId">[]): Promise<Record<string, ReleaseOrigin>> {
  const ids = [...new Set(releases.map((r) => r.taskId).filter((x): x is string => !!x))];
  if (!ids.length) return {};
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, employeeId: employees.id, employeeName: employees.name })
    .from(tasks)
    .leftJoin(employees, and(eq(employees.id, tasks.assigneeId), eq(employees.workspaceId, workspaceId)))
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids)));
  return Object.fromEntries(rows.map((t) => [t.id, { taskId: t.id, taskTitle: t.title, employeeId: t.employeeId, employeeName: t.employeeName }]));
}

/** the newer of two ISO-able dates, null when neither */
function newest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

function environmentDTO(e: EnvRow, serverName: string, cur: { r: ReleaseRow; by: string | null } | undefined, lastBackup: Date | null): AppEnvironmentDTO {
  return {
    id: e.id,
    kind: e.kind,
    serverId: e.serverId,
    serverName,
    domain: e.domain,
    extraDomains: e.extraDomains ?? [],
    url: `https://${e.domain}`,
    port: e.port,
    status: e.status,
    statusMessage: e.statusMessage,
    accessMode: e.accessMode,
    envKeys: envKeys(e.envEnc),
    hasDatabase: !!e.dbPasswordEnc || !!cur?.r.manifest?.database,
    memoryMb: e.memoryMb,
    healthy: e.healthy,
    lastHealthAt: e.lastHealthAt?.toISOString() ?? null,
    lastDeployedAt: e.lastDeployedAt?.toISOString() ?? null,
    currentRelease: cur ? releaseDTO(cur.r, cur.by, e.kind) : null,
    dnsCheck: e.dnsCheck ?? null,
    activeSlot: e.kind === "live" ? e.activeSlot : "blue",
    maintenance: e.maintenance,
    // the daily stamp, or any newer backup still on the server (manual, before a release or a restore)
    lastBackupAt: newest(e.lastBackupAt, lastBackup)?.toISOString() ?? null,
  };
}

/**
 * What the browser may see of an app and its environments: never the env values, the access passwords, APP_SECRET
 * or the database passwords — only the env names and whether a database exists. Only the app row's own fields and
 * app_environments are read (the environment columns left on `apps` are deprecated since 0028).
 */
export async function appDTOs(workspaceId: string, ids?: string[]): Promise<AppDTO[]> {
  if (ids && !ids.length) return [];
  const rows = await db
    .select({ a: apps, repositoryName: repositories.name })
    .from(apps)
    .leftJoin(repositories, eq(repositories.id, apps.repositoryId))
    .where(ids ? and(eq(apps.workspaceId, workspaceId), inArray(apps.id, ids)) : eq(apps.workspaceId, workspaceId))
    .orderBy(apps.name);
  if (!rows.length) return [];
  const envs = await db
    .select({ e: appEnvironments, serverName: servers.name })
    .from(appEnvironments)
    .innerJoin(servers, eq(servers.id, appEnvironments.serverId))
    .where(and(eq(appEnvironments.workspaceId, workspaceId), inArray(appEnvironments.appId, rows.map((r) => r.a.id))));
  const currentIds = envs.map((x) => x.e.currentReleaseId).filter((x): x is string => !!x);
  const current = currentIds.length
    ? await db
        .select({ r: appReleases, by: users.name })
        .from(appReleases)
        .leftJoin(users, eq(users.id, appReleases.createdBy))
        .where(and(eq(appReleases.workspaceId, workspaceId), inArray(appReleases.id, currentIds)))
    : [];
  const byId = new Map(current.map((x) => [x.r.id, x]));
  const backups = envs.length
    ? await db
        .select({ environmentId: appBackups.environmentId, at: max(appBackups.createdAt) })
        .from(appBackups)
        .where(and(eq(appBackups.workspaceId, workspaceId), inArray(appBackups.environmentId, envs.map((x) => x.e.id)), isNull(appBackups.deletedAt)))
        .groupBy(appBackups.environmentId)
    : [];
  const lastBackup = new Map(backups.map((b) => [b.environmentId, b.at]));
  const envOf = (appId: string, kind: AppEnvironmentKind) => {
    const x = envs.find((y) => y.e.appId === appId && y.e.kind === kind);
    return x ? environmentDTO(x.e, x.serverName, x.e.currentReleaseId ? byId.get(x.e.currentReleaseId) : undefined, lastBackup.get(x.e.id) ?? null) : null;
  };
  const out: AppDTO[] = [];
  for (const { a, repositoryName } of rows) {
    const preview = envOf(a.id, "preview");
    // every app is created with its preview (and 0028 made one for every older app): one without is being removed
    if (!preview) continue;
    out.push({
      id: a.id,
      name: a.name,
      slug: a.slug,
      repositoryId: a.repositoryId,
      repositoryName: repositoryName ?? null,
      branch: a.branch,
      clientId: a.clientId,
      projectId: a.projectId,
      createdAt: a.createdAt.toISOString(),
      preview,
      live: envOf(a.id, "live"),
    });
  }
  return out;
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
 * Which environment a route acts on: `?env=preview` (the default, also when absent) or `?env=live`. The same query
 * parameter on every environment route (env, access, deploy, rollback, stop, start).
 */
export function envKindParam(req: NextRequest): AppEnvironmentKind {
  const v = req.nextUrl.searchParams.get("env");
  if (v === null || v === "" || v === "preview") return "preview";
  if (v === "live") return "live";
  throw new HttpError(400, "Unknown environment", { code: "unknown_environment" });
}

/** The app's environment of that kind (404 live_not_found while it has no live environment). */
export async function loadEnv(workspaceId: string, appId: string, kind: AppEnvironmentKind): Promise<EnvRow> {
  const [e] = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.appId, appId), eq(appEnvironments.workspaceId, workspaceId), eq(appEnvironments.kind, kind)));
  if (!e && kind === "live") notFound("live_not_found");
  if (!e) notFound("app_not_found");
  return e;
}

/** An app and the environment the request names (`?env=`). */
export async function loadAppEnv(workspaceId: string, appId: string, req: NextRequest): Promise<{ app: AppRow; env: EnvRow }> {
  const kind = envKindParam(req);
  const app = await loadApp(workspaceId, appId);
  return { app, env: await loadEnv(workspaceId, app.id, kind) };
}

/**
 * What changes the live environment (deploy, rollback, start, create, remove) is the Owner's, confirmed with a fresh
 * password + 2FA step-up. Preview actions stay with Admins.
 */
export async function requireLiveOwner(session: Session) {
  requireOwner(session);
  await requireStepUp(session);
}

/** live settings an Owner changes without a step-up (stop, view the password, PATCH live) */
export function requireOwner(session: Session) {
  if (session.role !== "OWNER") throw new HttpError(403, "Requires OWNER role", { code: "role_required", role: "OWNER" });
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

/** the environment's server must be ready for anything that runs on it */
export async function assertServerReady(serverId: string) {
  const [server] = await db.select({ status: servers.status }).from(servers).where(eq(servers.id, serverId));
  if (server?.status !== "ready") throw new HttpError(409, "The server is not ready", { code: "server_not_ready" });
}

/** the lowest port of APP_PORT_MIN..APP_PORT_MAX no environment takes on this server, or null when the range is full */
export async function lowestFreePort(serverId: string, tx: Pick<typeof db, "select"> = db): Promise<number | null> {
  const used = new Set(
    (await tx.select({ port: appEnvironments.port }).from(appEnvironments).where(eq(appEnvironments.serverId, serverId))).map((r) => r.port),
  );
  for (let p = APP_PORT_MIN; p <= APP_PORT_MAX; p++) if (!used.has(p)) return p;
  return null;
}

/** the unique index a Postgres unique violation hit, null for any other error */
function uniqueConstraint(e: unknown): string | null {
  const err = (e as { cause?: unknown })?.cause ?? e;
  const pg = err as { code?: string; constraint_name?: string };
  return pg?.code === "23505" ? (pg.constraint_name ?? "") : null;
}

/** A unique-index violation on create/edit as the 409 the form shows; "port" for a lost port race (try the next one). */
export function appDuplicate(e: unknown): HttpError | "port" | null {
  const c = uniqueConstraint(e);
  if (c === null) return null;
  if (c === "app_env_server_port") return "port";
  if (c === "apps_ws_name") return new HttpError(409, "An app with this name already exists", { code: "app_name_taken" });
  return new HttpError(409, "This address is taken", { code: "app_slug_taken" });
}

/** The same for the live environment. */
export function liveDuplicate(e: unknown): HttpError | "port" | null {
  const c = uniqueConstraint(e);
  if (c === null) return null;
  if (c === "app_env_server_port") return "port";
  if (c === "app_env_app_kind") return new HttpError(409, "This app already has a live environment", { code: "live_exists" });
  if (c === "app_env_server_instance") return new HttpError(409, "That server already runs an instance with this name", { code: "live_instance_taken" });
  return new HttpError(409, "This domain is already used by an app", { code: "domain_taken" });
}

/**
 * First labels the platform keeps for itself under its own host and under that host's parent (api.<platform>,
 * www.<parent>, …): a live site never takes one. Names of other nginx sites on a server are the helper's to refuse.
 */
export const RESERVED_LIVE_HOSTS = ["www", "api", "app", "admin", "login", "auth", "mail", "status", "docs", "cdn", "static", "assets", "preview", "airis"] as const;

/** the domain claims of live environments are checked and written one at a time (POST / PATCH live) */
export async function lockDomainClaims(tx: Pick<typeof db, "execute">) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('wfos-app-domains'))`);
}

const isIpLiteral = (h: string) => /^[0-9.]+$/.test(h) || h.includes(":");

/**
 * The names of a live environment (domain + extraDomains, already lower case by customDomainSchema): no name twice;
 * none equal to or under any server's preview domain (live never takes a preview name; every server, not only this
 * workspace's); none that is the platform's or a server's own name (domain_reserved): a server's host, the
 * platform's host, every domain above it (its apex) and the reserved first labels under it and under its parent;
 * and none another environment uses, as its domain or one of its extra names (both directions). Run it inside the
 * transaction that writes the names, after lockDomainClaims.
 */
export async function assertLiveDomains(tx: Pick<typeof db, "select">, names: string[], exceptEnvId?: string) {
  if (new Set(names).size !== names.length) throw new HttpError(400, "A name is listed twice", { code: "domain_duplicate" });
  const rows = await tx.select({ base: servers.baseDomain, host: servers.host }).from(servers);
  const bases = rows.map((r) => r.base.toLowerCase());
  for (const name of names) {
    if (bases.some((b) => name === b || name.endsWith(`.${b}`))) {
      throw new HttpError(409, "This is a preview address", { code: "domain_is_preview", domain: name });
    }
  }
  const reserved = new Set(rows.map((r) => r.host.toLowerCase()).filter((h) => !isIpLiteral(h)));
  let platformHost = "";
  try {
    platformHost = new URL(serverEnv.appUrl).hostname.toLowerCase();
  } catch {
    // no usable APP_URL: nothing to compare with
  }
  if (platformHost && !isIpLiteral(platformHost)) {
    const labels = platformHost.split(".");
    // the host and every domain above it with at least two labels (its apex among them)
    for (let i = 0; i <= labels.length - 2; i++) reserved.add(labels.slice(i).join("."));
    const parent = labels.length > 2 ? labels.slice(1).join(".") : null;
    for (const l of RESERVED_LIVE_HOSTS) {
      reserved.add(`${l}.${platformHost}`);
      if (parent) reserved.add(`${l}.${parent}`);
    }
  }
  const hit = names.find((n) => reserved.has(n));
  if (hit) throw new HttpError(409, "This name belongs to the platform", { code: "domain_reserved", domain: hit });
  const list = sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );
  const [taken] = await tx
    .select({ domain: appEnvironments.domain, extra: appEnvironments.extraDomains })
    .from(appEnvironments)
    .where(
      and(
        or(inArray(appEnvironments.domain, names), sql`${appEnvironments.extraDomains} ?| array[${list}]::text[]`),
        exceptEnvId ? ne(appEnvironments.id, exceptEnvId) : undefined,
      ),
    )
    .limit(1);
  if (taken) {
    const name = names.find((n) => n === taken.domain || (taken.extra ?? []).includes(n)) ?? names[0]!;
    throw new HttpError(409, "This domain is already used by an app", { code: "domain_taken", domain: name });
  }
}

const removeConfirmSchema = z.object({ confirm: z.string().max(253) });

/**
 * Before the live site and its database go (DELETE live, or the whole app): it must not run (stop it first), and the
 * Owner types its domain as `{ confirm }`.
 */
export async function assertLiveRemovable(live: EnvRow, req: NextRequest) {
  if (live.status === "running" || live.status === "deploying" || (await activeRelease(live.id))) {
    throw new HttpError(409, "Stop the live site first", { code: "live_running" });
  }
  let json: unknown = null;
  try {
    json = await req.json();
  } catch {
    // no body: nothing was confirmed
  }
  const parsed = removeConfirmSchema.safeParse(json);
  if (!parsed.success || parsed.data.confirm.trim().toLowerCase() !== live.domain) {
    throw new HttpError(400, "Type the live domain to confirm", { code: "confirm_mismatch" });
  }
}

/** Deploys, rollbacks and starts wait while a removal of the app (or of its live environment) is queued. */
export async function assertNotRemoving(appId: string) {
  if (await redis().get(appRemoveLockKey(appId, serverEnv.namespace))) {
    throw new HttpError(409, "This app is being removed", { code: "app_removing" });
  }
}

/**
 * The env names of the live environment that changed (added, changed, removed) since the release live now started,
 * from the audit log (names only). Empty when nothing runs live yet.
 */
export async function liveEnvChanges(workspaceId: string, appId: string, live: EnvRow | undefined): Promise<string[]> {
  if (!live?.currentReleaseId) return [];
  const [cur] = await db
    .select({ startedAt: appReleases.startedAt, createdAt: appReleases.createdAt })
    .from(appReleases)
    .where(eq(appReleases.id, live.currentReleaseId));
  if (!cur) return [];
  const rows = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.targetId, appId),
        eq(auditLog.action, "app.env_updated"),
        gt(auditLog.createdAt, cur.startedAt ?? cur.createdAt),
        sql`${auditLog.details}->>'environmentId' = ${live.id}`,
      ),
    );
  const names = new Set<string>();
  for (const { details } of rows) {
    for (const k of ["added", "changed", "removed"]) {
      const v = details[k];
      if (Array.isArray(v)) for (const n of v) if (typeof n === "string") names.add(n);
    }
  }
  return [...names].sort();
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

/** Does the environment have a release a person is waiting for? (one deploy per environment at a time) */
export async function activeRelease(environmentId: string, tx: Pick<typeof db, "select"> = db) {
  const [r] = await tx
    .select({ id: appReleases.id })
    .from(appReleases)
    .where(and(eq(appReleases.environmentId, environmentId), inArray(appReleases.status, [...ACTIVE_RELEASE_STATUSES])))
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

/** how many backups the Backups section lists per environment (newest first) */
export const BACKUPS_SHOWN = 50;

/** The backups of an environment still on its server (pruned ones are kept as records, not listed), newest first. */
export async function backupDTOs(workspaceId: string, environmentId: string): Promise<AppBackupDTO[]> {
  const rows = await db
    .select({ b: appBackups, by: users.name })
    .from(appBackups)
    .leftJoin(users, eq(users.id, appBackups.createdBy))
    .where(and(eq(appBackups.workspaceId, workspaceId), eq(appBackups.environmentId, environmentId), isNull(appBackups.deletedAt)))
    .orderBy(desc(appBackups.createdAt))
    .limit(BACKUPS_SHOWN);
  return rows.map(({ b, by }) => ({
    id: b.id,
    environmentId: b.environmentId,
    name: b.name,
    kind: b.kind,
    sizeBytes: b.sizeBytes,
    offsite: b.offsite,
    releaseId: b.releaseId,
    createdAt: b.createdAt.toISOString(),
    createdByName: by ?? null,
  }));
}

/**
 * A database restore of the environment waits or runs (its queued db_restore job): releases, rollbacks, starts,
 * backups and another restore wait for it.
 */
export async function assertNoRestore(environmentId: string) {
  if ((await pendingDbJobs(environmentId)).includes("db_restore")) {
    throw new HttpError(409, "A database restore of this environment is under way", { code: "app_restore_running" });
  }
}

/** The database plan of each release that has a manifest (one built before B2 has no mode: "breaking", the default). */
export function releaseDbPlans(rows: { id: string; manifest: AppManifest | null }[]): Record<string, ReleaseDbPlan> {
  const out: Record<string, ReleaseDbPlan> = {};
  for (const r of rows) {
    if (!r.manifest) continue;
    out[r.id] = { database: !!r.manifest.database, migrations: r.manifest.migrations === "expand" ? "expand" : "breaking" };
  }
  return out;
}
