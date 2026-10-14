import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { appBackups, appEnvironments, apps, appReleases, audit, db, servers, users, workspaces } from "@wfos/db";
import { APP_DB_BACKUPS_KEPT, APP_LIVE_DAILY_BACKUPS_KEPT, type AppBackupKind, type DeployJob } from "@wfos/shared";
import type { SshTarget } from "@wfos/shared/ssh";
import { env as config } from "../lib/env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { deploysQueue, redis } from "../lib/redis";
import {
  envLabel,
  isOwner,
  mergeCheckpoint,
  notifyApp,
  notifyOwners,
  pendingGrace,
  publishEnvironment,
  publishSite,
  seedRedactor,
  servingUnit,
  slotFlags,
  slotPort,
  sshTarget,
  updateEnvironment,
  waitHealthy,
  type App,
  type Environment,
  type Release,
  type Server,
  type SlotUnit,
} from "./common";
import { helper, helperCall, type HelperOptions } from "./helper";
import { Redactor } from "./log";
import { parseManifest } from "./manifest";
import { appMsg } from "./messages";

type DbBackupJob = Extract<DeployJob, { kind: "db_backup" }>;
type DbRestoreJob = Extract<DeployJob, { kind: "db_restore" }>;
export type DbJobResult = "done" | "refused" | "failed" | null;

/**
 * Backup names on the server: `<kind>-<UTC stamp>` with the kind's underscore as a hyphen (the helper takes
 * 0-9 A-Z a-z - only), e.g. `daily-20261014T033000Z`. Each kind is pruned on its own (`--keep-kind <prefix>- <n>`).
 */
export const BACKUP_PREFIX: Record<AppBackupKind, string> = { pre_migrate: "pre-migrate", daily: "daily", manual: "manual", pre_restore: "pre-restore" };
export const BACKUPS_KEPT: Record<AppBackupKind, number> = {
  pre_migrate: APP_DB_BACKUPS_KEPT,
  daily: APP_LIVE_DAILY_BACKUPS_KEPT,
  manual: APP_DB_BACKUPS_KEPT,
  pre_restore: APP_DB_BACKUPS_KEPT,
};

/** 2026-10-14T03:30:00.123Z → 20261014T033000Z */
export const backupStamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

/** `<prefix>-<stamp>`, with a short suffix when that name is taken already (two backups in one second). */
async function freeBackupName(environmentId: string, kind: AppBackupKind, now: Date): Promise<string> {
  const base = `${BACKUP_PREFIX[kind]}-${backupStamp(now)}`;
  const [taken] = await db.select({ id: appBackups.id }).from(appBackups).where(and(eq(appBackups.environmentId, environmentId), eq(appBackups.name, base)));
  return taken ? `${base}-${randomBytes(2).toString("hex")}` : base;
}

/** The last line of a helper's stdout as JSON (null when it is not). */
function lastJson(stdout: string): unknown {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  for (const candidate of [lines.at(-1) ?? "", stdout.trim()]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  return null;
}

export interface TakenBackup {
  id: string;
  name: string;
  bytes: number | null;
  /** names the helper pruned with this dump */
  pruned: string[];
}

/**
 * `db-dump <instance> <name> --keep-kind <prefix>- <n>` (helper v4: prints `{"name":…,"bytes":…}` last, prunes that
 * kind beyond n), then the app_backups row, then the rows of backups the server no longer has are marked deleted.
 */
export async function takeBackup(
  t: SshTarget,
  e: Pick<Environment, "id" | "workspaceId" | "instanceName">,
  o: { kind: AppBackupKind; releaseId?: string | null; createdBy?: string | null; now?: Date; onData?: HelperOptions["onData"]; keep?: number },
): Promise<TakenBackup> {
  const now = o.now ?? new Date();
  const name = await freeBackupName(e.id, o.kind, now);
  const r = await helper(t, "db-dump", [e.instanceName, name, "--keep-kind", `${BACKUP_PREFIX[o.kind]}-`, o.keep ?? BACKUPS_KEPT[o.kind]], { timeoutMs: 600_000, onData: o.onData });
  const out = lastJson(r.stdout) as { name?: unknown; bytes?: unknown; pruned?: unknown } | null;
  const bytes = typeof out?.bytes === "number" && Number.isFinite(out.bytes) ? Math.round(out.bytes) : null;
  const [row] = await db
    .insert(appBackups)
    .values({ environmentId: e.id, workspaceId: e.workspaceId, name, kind: o.kind, sizeBytes: bytes, releaseId: o.releaseId ?? null, createdBy: o.createdBy ?? null, createdAt: now })
    .returning({ id: appBackups.id });
  // the dumps of that kind the helper pruned just now, then the whole list (prunes of any other kind)
  const pruned = Array.isArray(out?.pruned) ? out.pruned.filter((n): n is string => typeof n === "string" && n !== name) : [];
  if (pruned.length) {
    await db
      .update(appBackups)
      .set({ deletedAt: new Date() })
      .where(and(eq(appBackups.environmentId, e.id), isNull(appBackups.deletedAt), inArray(appBackups.name, pruned)));
  }
  await reconcileBackups(t, e).catch((err: unknown) => log.warn({ err: errorMessage(err), environmentId: e.id }, "backup list could not be compared with the server"));
  return { id: row!.id, name, bytes, pruned };
}

/**
 * `db-backups <instance>` (`[{name,bytes,mtime}]`): rows of backups the server no longer has (pruned) get deletedAt.
 * An unreadable or empty list changes nothing (right after a dump there is at least that one).
 */
export async function reconcileBackups(t: SshTarget, e: Pick<Environment, "id" | "instanceName">): Promise<number> {
  const r = await helper(t, "db-backups", [e.instanceName], { timeoutMs: 60_000 });
  const list = lastJson(r.stdout);
  if (!Array.isArray(list) || !list.length) return 0;
  const names = list.map((b) => (b && typeof b === "object" ? (b as { name?: unknown }).name : null)).filter((n): n is string => typeof n === "string");
  if (!names.length) return 0;
  const gone = await db
    .update(appBackups)
    .set({ deletedAt: new Date() })
    .where(and(eq(appBackups.environmentId, e.id), isNull(appBackups.deletedAt), notInArray(appBackups.name, names)))
    .returning({ id: appBackups.id });
  return gone.length;
}

// ---------------------------------------------------------------------------
// db_backup / db_restore jobs
// ---------------------------------------------------------------------------

interface DbCtx {
  app: App;
  e: Environment;
  server: Server;
  target: SshTarget;
  current: Release | null;
  locale: string | null;
  killSwitch: boolean;
  demoMode: boolean;
  actorLabel: string;
  userId: string | null;
}

type Loaded = { c: DbCtx } | { refuse: string; message: string; e: Environment | null; app: App | null } | null;

async function load(job: DbBackupJob | DbRestoreJob): Promise<Loaded> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, job.appId), eq(apps.workspaceId, job.workspaceId)));
  if (!app) return null;
  const [e] = await db.select().from(appEnvironments).where(and(eq(appEnvironments.id, job.environmentId), eq(appEnvironments.appId, app.id), eq(appEnvironments.workspaceId, job.workspaceId)));
  if (!e) return null;
  const [server] = await db.select().from(servers).where(and(eq(servers.id, e.serverId), eq(servers.workspaceId, e.workspaceId)));
  const target = server ? await sshTarget(server) : null;
  if (!server || !target) return { refuse: "server_unavailable", message: "The environment's server has no usable SSH key or pinned host key", e, app };
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch, demoMode: workspaces.demoMode, locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, job.workspaceId));
  const [who] = job.userId ? await db.select({ email: users.email }).from(users).where(eq(users.id, job.userId)) : [];
  const [current] = e.currentReleaseId ? await db.select().from(appReleases).where(and(eq(appReleases.id, e.currentReleaseId), eq(appReleases.environmentId, e.id))) : [];
  return {
    c: { app, e, server, target, current: current ?? null, locale: ws?.locale ?? null, killSwitch: !!ws?.killSwitch, demoMode: !!ws?.demoMode, actorLabel: who?.email ?? "system", userId: job.userId },
  };
}

const record = (o: { app: App; e: Environment; userId: string | null; actorLabel: string }, action: string, details: Record<string, unknown>) =>
  audit({
    workspaceId: o.app.workspaceId,
    actorUserId: o.userId,
    actorLabel: o.actorLabel,
    action,
    targetType: "app",
    targetId: o.app.id,
    details: { environmentId: o.e.id, environment: o.e.kind, instance: o.e.instanceName, ...details },
  });

/** The environment has a database: its secret was made (a release created it) and the current manifest asks for one. */
function hasDatabase(e: Environment, current: Release | null): boolean {
  if (!e.dbPasswordEnc || !current?.manifest) return false;
  try {
    return parseManifest(current.manifest).database;
  } catch {
    return false;
  }
}

/** The deploys queue's db_backup / db_restore jobs (one at a time with releases and actions: never beside a release). */
export async function runDbJob(job: DbBackupJob | DbRestoreJob): Promise<DbJobResult> {
  const loaded = await load(job);
  if (!loaded) return null;
  if ("refuse" in loaded) {
    if (loaded.e && loaded.app) {
      await record({ app: loaded.app, e: loaded.e, userId: job.userId, actorLabel: "system" }, job.kind === "db_backup" ? "app.backup_refused" : "app.restore_refused", { code: loaded.refuse, message: loaded.message });
      if (job.kind === "db_restore") await updateEnvironment(loaded.e, { statusMessage: "restore_failed" });
      else await publishEnvironment(loaded.e);
    }
    return "refused";
  }
  return job.kind === "db_backup" ? backupJob(loaded.c, job) : restoreJob(loaded.c, job);
}

async function backupJob(c: DbCtx, job: DbBackupJob): Promise<DbJobResult> {
  const kind: AppBackupKind = job.backupKind === "daily" ? "daily" : "manual";
  const refuse = async (code: string, message: string) => {
    log.info({ environmentId: c.e.id, code }, "backup refused");
    await record(c, "app.backup_refused", { code, message, kind });
    await publishEnvironment(c.e);
    return "refused" as const;
  };
  if (c.demoMode) return refuse("dry_run", "Dry run: no backup is taken");
  if (!hasDatabase(c.e, c.current)) return refuse("no_database", "The environment has no database");
  try {
    const b = await takeBackup(c.target, c.e, { kind, createdBy: job.userId });
    if (kind === "daily") await updateEnvironment(c.e, { lastBackupAt: new Date() });
    else await publishEnvironment(c.e);
    await record(c, "app.backup_created", { backupId: b.id, name: b.name, kind, bytes: b.bytes });
    return "done";
  } catch (err) {
    const error = redactFor(c.e).apply(errorMessage(err)).slice(0, 500);
    log.warn({ environmentId: c.e.id, err: error, kind }, "backup failed");
    await record(c, "app.backup_failed", { kind, error });
    await publishEnvironment(c.e);
    const msg = {
      subject: appMsg(c.locale, "app.backupFailed", { name: envLabel(c.app, c.e) }),
      text: appMsg(c.locale, "app.backupFailedText", { name: envLabel(c.app, c.e), kind, error: error.slice(0, 300) }),
    };
    // a daily backup nobody started: the Owners hear of it; a manual one: whoever asked
    if (job.userId) await notifyApp({ workspaceId: c.app.workspaceId, appId: c.app.id, userId: job.userId, kind: "task_failed", ...msg });
    else await notifyOwners({ workspaceId: c.app.workspaceId, appId: c.app.id, kind: "incident", ...msg });
    return "failed";
  }
}

function redactFor(e: Environment): Redactor {
  const r = new Redactor();
  seedRedactor(e, r);
  return r;
}

/**
 * Restore an environment's database from one of its backups (an Owner, from the web; the job stays active for the
 * whole restore, which is how the web sees one under way):
 * 1. statusMessage "restoring" (what recovery after a worker restart looks for); when the app runs (or is behind the
 *    maintenance page already) the maintenance page;
 * 2. every unit that can hold a connection stopped: the serving one and a live grace unit (never a restore, nor the
 *    dump before it, under a running app);
 * 3. a `pre_restore` backup of the data as it is now (its pruning never removes the backup being restored); when it
 *    fails: the app started again, nothing restored, restore_failed;
 * 4. `db-restore`; 5. the app started again, health, the site back, maintenance off.
 * A failure of 4 or 5: the pre_restore backup is restored (units stopped first) and the app started again.
 * nginx and the maintenance flag always agree: the app ends running → the normal site, flag off; it was meant to run
 * but does not answer → the maintenance page stays, flag on, LIVE failed; it was stopped → it stays stopped.
 * statusMessage restore_failed on any failure; the Owners hear of it.
 */
async function restoreJob(c: DbCtx, job: DbRestoreJob): Promise<DbJobResult> {
  const { e, app, target } = c;
  const refuse = async (code: string, message: string) => {
    log.info({ environmentId: e.id, code }, "restore refused");
    await record(c, "app.restore_refused", { code, message, backupId: job.backupId });
    await updateEnvironment(e, { statusMessage: "restore_failed" });
    return "refused" as const;
  };
  if (c.killSwitch) return refuse("kill_switch", "The kill switch is engaged");
  if (c.demoMode) return refuse("dry_run", "Dry run: nothing is restored");
  if (!(await isOwner(app.workspaceId, job.userId))) return refuse("owner_required", "Only an Owner of the workspace can restore a database");
  const [backup] = await db.select().from(appBackups).where(and(eq(appBackups.id, job.backupId), eq(appBackups.environmentId, e.id)));
  if (!backup) return refuse("backup_missing", "The backup is not one of this environment's");
  if (backup.deletedAt) return refuse("backup_deleted", "The backup was pruned from the server");
  if (!hasDatabase(e, c.current)) return refuse("no_database", "The environment has no database");

  const redactor = redactFor(e);
  const inst = e.instanceName;
  const cur = c.current!;
  const m = parseManifest(cur.manifest);
  // it runs, or a failure left it behind the maintenance page: it is meant to run again afterwards
  const wantRunning = e.status === "running" || e.maintenance;
  const unit: SlotUnit | null = e.kind === "live" ? servingUnit(e, cur) : null;
  const port = unit ? slotPort(e, unit) : e.port;
  const flags = slotFlags(unit);
  const grace = e.kind === "live" ? pendingGrace(cur) : null;
  const say = () => {};

  const stopAll = async () => {
    await helper(target, "unit-stop", [inst, ...flags], { timeoutMs: 60_000 });
    if (grace) {
      // the release before still runs for its grace time: it talks to the same database
      await helper(target, "unit-stop", [inst, ...slotFlags(grace.slot)], { timeoutMs: 60_000 });
      await mergeCheckpoint(cur.id, { graceDone: true });
    }
  };
  /** the app back (when it is meant to run): the outcome for nginx, the row and the message */
  const startAgain = async (): Promise<{ back: boolean; state: RestoreState }> => {
    if (!wantRunning) return { back: true, state: "app.stateRestoreBackStopped" };
    await helper(target, "unit-start", [inst, ...flags], { timeoutMs: 120_000 });
    const h = await waitHealthy(target, e, m.health, say, port);
    if (!h.ok) return { back: false, state: "app.stateRestoreMaintenance" };
    await publishSite(target, e, redactor, { port });
    return { back: true, state: "app.stateRestoreBack" };
  };
  /** the row as nginx now is (never the flag off while the page is served) */
  const rowAfter = (back: boolean) =>
    wantRunning ? (back ? { status: "running" as const, maintenance: false, healthy: true, lastHealthAt: new Date() } : { status: "failed" as const, maintenance: true, healthy: false }) : { maintenance: false };
  const failed = async (stage: string, error: string, out: { back: boolean; state: RestoreState }, preRestore: string | null, error2: string | null = null) => {
    if (!out.back && wantRunning) await publishSite(target, e, redactor, { port, maintenance: true }).catch(() => null);
    await updateEnvironment(e, { statusMessage: "restore_failed", ...rowAfter(out.back) });
    await record(c, "app.restore_failed", { backupId: backup.id, name: backup.name, stage, error, preRestore, state: out.state, ...(error2 ? { error2 } : {}) });
    await notifyRestoreFailed(c, backup.name, error, out.state, preRestore, error2);
    return "failed" as const;
  };
  const tryStartAgain = async (): Promise<{ out: { back: boolean; state: RestoreState }; error2: string | null }> => {
    try {
      return { out: await startAgain(), error2: null };
    } catch (err2) {
      return { out: { back: false, state: "app.stateRestoreUnknown" }, error2: redactor.apply(errorMessage(err2)).slice(0, 300) };
    }
  };

  // 1 + 2: nothing writes any more
  try {
    await updateEnvironment(e, { statusMessage: "restoring" });
    if (wantRunning) {
      await publishSite(target, e, redactor, { port, maintenance: true });
      await updateEnvironment(e, { maintenance: true });
    }
    await stopAll();
  } catch (err) {
    const error = redactor.apply(errorMessage(err)).slice(0, 500);
    const { out, error2 } = await tryStartAgain();
    return failed("stop", error, out, null, error2);
  }

  // 3: the data as it is now (a pre_restore backup being restored is kept by its pruning)
  let pre: TakenBackup;
  try {
    let keep = BACKUPS_KEPT.pre_restore;
    if (backup.kind === "pre_restore") {
      const [n] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appBackups)
        .where(and(eq(appBackups.environmentId, e.id), eq(appBackups.kind, "pre_restore"), isNull(appBackups.deletedAt), gte(appBackups.createdAt, backup.createdAt)));
      keep = Math.min(365, Math.max(keep, (n?.n ?? 0) + 1));
    }
    pre = await takeBackup(target, e, { kind: "pre_restore", createdBy: job.userId, keep });
    if (pre.pruned.includes(backup.name)) throw new Error(`the backup ${backup.name} was pruned by the dump before it; nothing was restored`);
  } catch (err) {
    const error = redactor.apply(errorMessage(err)).slice(0, 500);
    const { out, error2 } = await tryStartAgain();
    return failed("pre_restore_backup", error, out.back ? { back: true, state: "app.stateRestoreNothing" } : out, null, error2);
  }

  // 4 + 5
  let stage: "restore" | "start" = "restore";
  try {
    await helper(target, "db-restore", [inst, backup.name], { timeoutMs: 600_000 });
    stage = "start";
    const out = await startAgain();
    if (!out.back) throw new Error(`the app did not answer 2xx on ${m.health} with the restored database`);
    await updateEnvironment(e, { statusMessage: null, ...rowAfter(true) });
    await record(c, "app.restored", { backupId: backup.id, name: backup.name, kind: backup.kind, backupAt: backup.createdAt.toISOString(), preRestore: pre.name });
    await notifyApp({
      workspaceId: app.workspaceId,
      appId: app.id,
      userId: job.userId,
      kind: "task_done",
      subject: appMsg(c.locale, "app.restored", { name: envLabel(app, e) }),
      text: appMsg(c.locale, "app.restoredText", { name: envLabel(app, e), backup: backup.name, preRestore: pre.name }),
    });
    return "done";
  } catch (err) {
    const error = redactor.apply(errorMessage(err)).slice(0, 500);
    log.warn({ environmentId: e.id, stage, err: error }, "restore failed");
    let out: { back: boolean; state: RestoreState };
    let error2: string | null = null;
    try {
      // the database goes back to how it was only after nothing runs on it any more
      await stopAll();
      await helper(target, "db-restore", [inst, pre.name], { timeoutMs: 600_000 });
      out = await startAgain();
    } catch (err2) {
      error2 = redactor.apply(errorMessage(err2)).slice(0, 300);
      out = { back: false, state: "app.stateRestoreUnknown" };
    }
    return failed(stage, error, out, pre.name, error2);
  }
}

type RestoreState = "app.stateRestoreNothing" | "app.stateRestoreBack" | "app.stateRestoreBackStopped" | "app.stateRestoreMaintenance" | "app.stateRestoreUnknown";

async function notifyRestoreFailed(c: Pick<DbCtx, "app" | "e" | "locale">, backup: string, error: string, state: RestoreState, preRestore: string | null, error2: string | null = null): Promise<void> {
  await notifyOwners({
    workspaceId: c.app.workspaceId,
    appId: c.app.id,
    kind: "incident",
    subject: appMsg(c.locale, "app.restoreFailed", { name: envLabel(c.app, c.e) }),
    text: appMsg(c.locale, "app.restoreFailedText", {
      backup,
      error: error.slice(0, 300),
      state: appMsg(c.locale, state, { preRestore: preRestore ?? "-", error: error2 ?? "" }),
    }),
  });
}

/**
 * Worker start (before the deploys worker takes jobs): an environment left "restoring" had its restore cut off. The
 * database holds either the chosen backup or the data from before (pg_restore runs in one transaction); the app is
 * started again when it ran (health, site back, maintenance off), otherwise the maintenance page stays. Always
 * statusMessage restore_failed and the Owners are told. Returns the environment ids settled.
 */
export async function recoverInterruptedRestores(): Promise<string[]> {
  const rows = await db.select().from(appEnvironments).where(eq(appEnvironments.statusMessage, "restoring"));
  const out: string[] = [];
  for (const e of rows) {
    try {
      const [app] = await db.select().from(apps).where(eq(apps.id, e.appId));
      const [server] = await db.select().from(servers).where(eq(servers.id, e.serverId));
      const [ws] = await db.select({ locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, e.workspaceId));
      const [cur] = e.currentReleaseId ? await db.select().from(appReleases).where(eq(appReleases.id, e.currentReleaseId)) : [];
      const target = server ? await sshTarget(server) : null;
      if (!app) continue;
      let state: RestoreState = "app.stateRestoreUnknown";
      let back = false;
      // the restore switched the maintenance page on for an app meant to run
      const wantRunning = e.status === "running" || e.maintenance;
      if (!wantRunning) {
        state = "app.stateRestoreBackStopped";
        back = true;
      } else if (target && cur?.manifest) {
        const unit: SlotUnit | null = e.kind === "live" ? servingUnit(e, cur) : null;
        const port = unit ? slotPort(e, unit) : e.port;
        const redactor = redactFor(e);
        try {
          await helperCall(target, "unit-status", [e.instanceName], { timeoutMs: 30_000 });
          await helper(target, "unit-start", [e.instanceName, ...slotFlags(unit)], { timeoutMs: 120_000 });
          const h = await waitHealthy(target, e, parseManifest(cur.manifest).health, () => {}, port);
          if (h.ok) {
            await publishSite(target, e, redactor, { port });
            state = "app.stateRestoreBack";
            back = true;
          } else {
            await publishSite(target, e, redactor, { port, maintenance: true }).catch(() => null);
            state = "app.stateRestoreMaintenance";
          }
        } catch (err) {
          log.warn({ environmentId: e.id, err: errorMessage(err) }, "interrupted restore: the app could not be started again");
        }
      }
      // never the flag off while nginx may still serve the page
      await updateEnvironment(e, {
        statusMessage: "restore_failed",
        maintenance: wantRunning && !back,
        ...(wantRunning ? (back ? { status: "running" as const, healthy: true, lastHealthAt: new Date() } : { status: "failed" as const, healthy: false }) : {}),
      });
      await audit({ workspaceId: e.workspaceId, actorLabel: "system", action: "app.restore_failed", targetType: "app", targetId: e.appId, details: { environmentId: e.id, environment: e.kind, stage: "interrupted", state } });
      await notifyRestoreFailed({ app, e, locale: ws?.locale ?? null }, "?", "interrupted (the worker stopped)", state, null);
      out.push(e.id);
    } catch (err) {
      log.error({ err, environmentId: e.id }, "interrupted restore could not be settled");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// daily backups
// ---------------------------------------------------------------------------

/** a daily backup is due when the last one is this old (a day, less one apps tick so the time does not creep) */
export const DAILY_BACKUP_DUE_MS = 24 * 60 * 60_000 - 10 * 60_000;
/** a failed (or still queued) daily backup is queued again after this long */
const DAILY_RETRY_MS = 6 * 60 * 60_000;

/**
 * Running LIVE environments with a database whose last daily backup is a day old (or none) get a `db_backup` daily
 * job; a Redis claim keeps a tick from queueing it twice while it waits or after it failed (retried after 6 h).
 */
export async function queueDailyBackups(now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - DAILY_BACKUP_DUE_MS);
  const rows = await db
    .select({ e: appEnvironments, manifest: appReleases.manifest, demoMode: workspaces.demoMode })
    .from(appEnvironments)
    .innerJoin(appReleases, eq(appReleases.id, appEnvironments.currentReleaseId))
    .innerJoin(servers, eq(servers.id, appEnvironments.serverId))
    .innerJoin(workspaces, eq(workspaces.id, appEnvironments.workspaceId))
    .where(
      and(
        eq(appEnvironments.kind, "live"),
        inArray(appEnvironments.status, ["running"]),
        isNotNull(appEnvironments.dbPasswordEnc),
        eq(servers.status, "ready"),
        or(isNull(appEnvironments.lastBackupAt), lte(appEnvironments.lastBackupAt, cutoff)),
      ),
    );
  const out: string[] = [];
  for (const { e, manifest, demoMode } of rows) {
    if (demoMode) continue;
    try {
      if (!parseManifest(manifest).database) continue;
    } catch {
      continue;
    }
    if ((await redis.set(`${config.namespace}:app-daily-backup:${e.id}`, "1", "PX", DAILY_RETRY_MS, "NX")) === null) continue;
    await deploysQueue.add(
      "db_backup",
      { kind: "db_backup", appId: e.appId, workspaceId: e.workspaceId, environmentId: e.id, userId: null, backupKind: "daily" },
      { jobId: `db_backup-${e.id}-daily-${now.getTime()}` },
    );
    out.push(e.id);
  }
  return out;
}
