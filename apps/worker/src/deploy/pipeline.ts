import { Transform } from "node:stream";
import { and, eq, inArray, ne } from "drizzle-orm";
import { appBackups, appEnvironments, approvals, apps, appReleases, audit, db, repositories, servers, tasks, users, workspaces } from "@wfos/db";
import { APP_LIVE_GRACE_SECONDS, RELEASE_STEPS, requestReleasePayloadSchema, WFOS_HELPER_VERSION, type AppManifest, type AppSlot, type AppStatus, type ReleaseStatus, type ReleaseStep } from "@wfos/shared";
import { decryptSecret } from "@wfos/shared/server";
import { sftpPut, type SshTarget } from "@wfos/shared/ssh";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { publish } from "../lib/redis";
import { mirrorPath, rootGitSpawn, SAFE_REF, syncMirror, type RepoRef } from "../runner/workspace/git";
import { recheckServer } from "../scheduler/servers";
import {
  appEnvFile,
  appUrl,
  checkLiveDns,
  deployTiming,
  dnsLine,
  dnsRefusalMessage,
  isOwner,
  liveNames,
  namesUnchangedSince,
  recordPublishedNames,
  envLabel,
  idleSlot,
  mergeCheckpoint,
  notifyOwners,
  pendingGrace,
  readSlots,
  servingUnit,
  slotFlags,
  slotOfUnit,
  slotPort,
  type SlotUnit,
  extraEnv,
  forbiddenEnvKeys,
  forbiddenEnvMessage,
  notifyApp,
  publicCheck,
  publishRelease,
  publishSite,
  runningAppsOn,
  seedRedactor,
  sha8,
  sshTarget,
  statusWithoutChange,
  unitStatus,
  updateEnvironment,
  updateRelease,
  waitHealthy,
  type App,
  type Environment,
  type LiveCheckpoint,
  type Release,
  type Server,
} from "./common";
import { helper, helperCall, HELPER_EXIT_GUARD, HelperError, statusCodeOf, type HelperOptions } from "./helper";
import { Redactor, ReleaseLog } from "./log";
import { assertCommit, commitSubject, DeployInputError, expandRefusalMessage, expandViolations, parseManifest, readManifest, releaseWarnings, resolveBranch } from "./manifest";
import { takeBackup } from "./backups";
import { GRACE_MS, queueGraceStop } from "./slots";
import { appMsg } from "./messages";
import { outsideWindowMessage } from "./window";
import { afterReleaseSettled } from "../runner/approvals";

/** git archive of a release, at most */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const INSTALL_TIMEOUT_SEC = 900;
const BUILD_TIMEOUT_SEC = 1200;
const MIGRATE_TIMEOUT_SEC = 300;
const MIGRATE_MEMORY_MB = 1024;
const BUILD_MEMORY_MB = 1536;

/** Set on shutdown: a deploy that has not switched anything on yet stops at its next step (and fails cleanly). */
export const deployControl = { stopping: false };

interface RunState {
  step: ReleaseStep;
  /** the environment was set to deploying (refusals in prepare leave it untouched) */
  appTouched: boolean;
  appStatusBefore: AppStatus;
  envInstalled: boolean;
  /** the migration started (a failed one may have changed the schema halfway) */
  migrated: boolean;
  backup: string | null;
  /** `release-activate` of the new version was attempted: from here a failure rolls back */
  activated: boolean;
  /** the running version was stopped for the migration (maintenance): a failure before activate starts it again */
  oldStopped: boolean;
}

/**
 * A LIVE release (blue-green, B2): the new version starts in the idle slot while the old unit keeps serving, nginx is
 * switched to it, and the old unit keeps running for the grace time. What a failure (or recovery) needs to undo it.
 */
interface LiveState {
  /** the unit of the current release (null: nothing was deployed) */
  oldUnit: SlotUnit | null;
  /** it served when the release started (running, no maintenance page) */
  oldServes: boolean;
  /** the maintenance page was on before this release (a failed restore): a failure leaves it on */
  maintenanceBefore: boolean;
  activeSlotBefore: AppSlot;
  /** where this release runs: the idle slot (an instant rollback: the grace unit it goes back to) */
  newUnit: SlotUnit;
  instant: boolean;
  /** the release folder was on the server already (a slot holds it): no install / build / migrate */
  reused: boolean;
  /** breaking migration with the old version serving: maintenance page on and old unit stopped for it */
  breaking: boolean;
  /** a failure after the migration restores the database (migrations "breaking") */
  restoreDb: boolean;
  /** the maintenance page is (or may be) on because of this release */
  maintenanceOn: boolean;
  /** the idle slot's unit was (re)started with this release */
  newStarted: boolean;
  /** nginx was (or may have been) pointed at newUnit */
  switched: boolean;
}

interface Ctx {
  rel: Release;
  app: App;
  /** where the release runs (release.environmentId): its instance, port, domain, env and status */
  env: Environment;
  server: Server;
  target: SshTarget;
  mirror: string;
  locale: string | null;
  sha: string;
  manifest: AppManifest;
  /** the release that runs now (null: first deploy) and its manifest */
  current: Release | null;
  currentManifest: AppManifest | null;
  log: ReleaseLog;
  redactor: Redactor;
  state: RunState;
  /** what is stored in release.checkpoint (for a restart mid-deploy) */
  checkpoint: LiveCheckpoint;
  /** live environments only */
  live: LiveState | null;
}

/** A deploy refused before anything happened (kill switch, dry run, server not ready, capacity…). */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

const stepIndex = (s: ReleaseStep) => RELEASE_STEPS.indexOf(s);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One step: release.step + release.updated, a header line, the duration; on shutdown, no new pre-activate step. */
async function step<T>(c: Ctx, name: ReleaseStep, fn: () => Promise<T>): Promise<T> {
  if (deployControl.stopping && !c.state.activated && stepIndex(name) < stepIndex("health")) {
    throw new Error("The worker is shutting down; the deploy stopped before switching anything on");
  }
  c.state.step = name;
  c.log.line(`==> ${name}`);
  await c.log.flush();
  await updateRelease(c.rel, { step: name });
  const t0 = Date.now();
  try {
    const r = await fn();
    c.log.line(`<== ${name} ok (${secs(Date.now() - t0)})`);
    await c.log.flush();
    return r;
  } catch (e) {
    c.log.line(`<== ${name} FAILED after ${secs(Date.now() - t0)}: ${errorMessage(e)}`);
    throw e;
  }
}

/** A helper command whose output goes to the release log. */
async function run(c: Ctx, cmd: string, args: (string | number)[], o: HelperOptions = {}): Promise<string> {
  const r = await helper(c.target, cmd, args, { onData: (s) => c.log.write(s), ...o });
  return r.stdout;
}

const say = (c: Ctx) => (line: string) => c.log.line(line);

/** Store how far the release got (release.checkpoint): what recovery after a restart needs to undo it. */
async function checkpoint(c: Ctx, patch: Partial<LiveCheckpoint>): Promise<void> {
  c.checkpoint = { ...c.checkpoint, ...patch };
  await db.update(appReleases).set({ checkpoint: c.checkpoint }).where(eq(appReleases.id, c.rel.id));
}

/** Memory for a build-run: `want`, capped at half the server's memory (the helper refuses more). */
function buildMemory(s: Server, want: number): number {
  const half = Math.floor((s.info?.memTotalMb ?? 0) / 2);
  return Math.max(256, half > 0 ? Math.min(want, half) : want);
}

/** unit-install of the environment's unit (a live slot: its own port and `--slot`). */
async function unitInstall(c: Ctx, m: AppManifest, unit: SlotUnit | null = null): Promise<void> {
  const port = unit ? slotPort(c.env, unit) : c.env.port;
  await run(c, "unit-install", [c.env.instanceName, port, m.memoryMb, ...(m.database ? ["--database"] : []), ...slotFlags(unit)], { stdin: `${m.start}\n` });
}

async function installEnv(c: Ctx, sha: string, m: AppManifest): Promise<void> {
  const file = await appEnvFile(c.env, sha, m, c.redactor, c.server.info?.postgresPort ?? null);
  await run(c, "env-install", [c.env.instanceName], { stdin: file });
  c.log.line(`env: ${file.split("\n").filter(Boolean).length} variables installed (values not shown)`);
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

/** release statuses that mean the commit ran in that environment (now or before) */
const DEPLOYED_STATUSES = ["deployed", "superseded"] as const;

/**
 * Live only: the commit must have run in the app's preview (deployed now or before), and the release must name the
 * preview release it promotes (when it does, that one must be of the preview and of this commit). A rollback of
 * live may also bring back a commit that ran on live before. Returns a refusal message, or null.
 */
async function livePromotionRefusal(c: Ctx, sha: string): Promise<string | null> {
  const { rel, app } = c;
  const [preview] = await db.select({ id: appEnvironments.id }).from(appEnvironments).where(and(eq(appEnvironments.appId, app.id), eq(appEnvironments.kind, "preview")));
  if (rel.promotedFromReleaseId) {
    const [from] = await db.select({ environmentId: appReleases.environmentId, commit: appReleases.commit, status: appReleases.status }).from(appReleases).where(eq(appReleases.id, rel.promotedFromReleaseId));
    if (!from || !preview || from.environmentId !== preview.id) return "The release it promotes is not a release of this app's preview";
    if (from.commit !== sha) return `The release it promotes ran commit ${sha8(from.commit)}, not ${sha8(sha)}`;
  }
  const ranIn = async (environmentId: string) =>
    (
      await db
        .select({ id: appReleases.id })
        .from(appReleases)
        .where(and(eq(appReleases.environmentId, environmentId), eq(appReleases.commit, sha), inArray(appReleases.status, [...DEPLOYED_STATUSES])))
        .limit(1)
    ).length > 0;
  if (preview && (await ranIn(preview.id))) return null;
  if (rel.trigger === "rollback" && (await ranIn(c.env.id))) return null;
  return `Commit ${sha8(sha)} never ran in this app's preview: deploy it to the preview first, check it there, then release it to LIVE`;
}

/**
 * Live only: the domain(s) must point at the server, asked of public DNS now (stored on the environment, so the web
 * shows what the worker saw). A certificate is never asked for a name that does not point here. One exemption: a
 * rollback of a RUNNING live site whose names are the ones its current release published goes on when public DNS
 * merely did not answer (status error); wrong or missing still refuse.
 */
async function liveDnsRefusal(c: Ctx): Promise<string | null> {
  const check = await checkLiveDns(c.env, c.server);
  c.log.line(dnsLine(check));
  if (check.status === "ok") return null;
  if (check.status === "error" && c.rel.trigger === "rollback" && c.env.status === "running" && namesUnchangedSince(c.env, c.current)) {
    c.log.line(`dns: public DNS did not answer, but the names are the ones ${c.current ? sha8(c.current.commit) : "the running release"} published: the rollback goes on`);
    return null;
  }
  return dnsRefusalMessage(check, c.server.name);
}

/**
 * A LIVE release a task brought (trigger "approval", B3): only from a request_release approval of the same task and
 * workspace, decided by an Owner (who is also the release's createdBy), never edited, naming exactly this environment,
 * commit and preview release. The approval is EXECUTED, or still EXECUTING when the deploy worker was faster than
 * executeApproval storing its result (the executor that queued this release is that very execution).
 */
async function ownerApprovedLiveRelease(rel: Release): Promise<boolean> {
  if (rel.trigger !== "approval" || !rel.approvalId || !rel.taskId || !rel.createdBy) return false;
  const [a] = await db.select().from(approvals).where(and(eq(approvals.id, rel.approvalId), eq(approvals.workspaceId, rel.workspaceId)));
  if (!a || a.toolName !== "request_release" || a.taskId !== rel.taskId || a.editedPayload) return false;
  if (a.status !== "EXECUTED" && a.status !== "EXECUTING") return false;
  if (!a.decidedBy || a.decidedBy !== rel.createdBy || !(await isOwner(rel.workspaceId, a.decidedBy))) return false;
  const p = requestReleasePayloadSchema.safeParse(a.payload);
  return p.success && p.data.environmentId === rel.environmentId && p.data.commit === rel.commit && p.data.fromReleaseId === rel.promotedFromReleaseId && p.data.appId === rel.appId;
}

/** Refusals, then the commit, its manifest and the warnings. */
async function prepare(c: Ctx, ws: { killSwitch: boolean; demoMode: boolean }): Promise<void> {
  const { rel, app, env, server } = c;
  const live = env.kind === "live";
  if (ws.killSwitch) throw new Refusal("The kill switch is engaged: nothing is deployed");
  const [task] = rel.taskId ? await db.select({ dryRun: tasks.dryRun }).from(tasks).where(eq(tasks.id, rel.taskId)) : [];
  if (ws.demoMode || task?.dryRun) throw new Refusal("Dry run: nothing is deployed");
  if (live) {
    // LIVE is an Owner's decision: on the web (with step-up), or an Owner approving a task's request_release (B3);
    // any other task or approval origin is refused
    if ((rel.taskId || rel.approvalId || rel.trigger === "approval") && !(await ownerApprovedLiveRelease(rel))) {
      throw new Refusal("A task cannot release to LIVE: an Owner releases a checked preview (or approves the task's request_release)");
    }
    if (!(await isOwner(c.app.workspaceId, c.rel.createdBy))) throw new Refusal("Only an Owner of the workspace can release to LIVE");
    if (!rel.commit) throw new Refusal("A LIVE release names the commit it brings (a release of the preview)");
    const refusal = await livePromotionRefusal(c, rel.commit);
    if (refusal) throw new Refusal(refusal);
    // the release window (B3), as stored now (an Owner may have changed it while the release waited); a rollback always passes
    if (rel.trigger !== "rollback") {
      const [w] = await db.select({ releaseWindow: appEnvironments.releaseWindow }).from(appEnvironments).where(eq(appEnvironments.id, env.id));
      const outside = outsideWindowMessage(w ? w.releaseWindow : env.releaseWindow);
      if (outside) {
        // a closed window is not a failure of the code: a task does not count it toward its attempts
        await checkpoint(c, { refusal: "release_window" });
        throw new Refusal(outside);
      }
    }
  }
  if (server.status !== "ready") throw new Refusal(`Server ${server.name} is not ready (${server.status}); check it in Settings → Servers`);
  if ((server.info?.helperVersion ?? 0) < WFOS_HELPER_VERSION) {
    // the stored check may predate a prepare.sh re-run: ask the server itself before refusing
    await recheckServer(server).catch((e: unknown) => log.warn({ err: e, serverId: server.id }, "server re-check before a deploy failed"));
    const [fresh] = await db.select().from(servers).where(eq(servers.id, server.id));
    if (fresh) Object.assign(server, fresh);
    // an outdated helper is reported below with its version; anything else that failed the check is "not ready"
    if (server.status !== "ready" && server.statusMessage !== "helper_outdated") throw new Refusal(`Server ${server.name} is not ready (${server.status}); check it in Settings → Servers`);
  }
  const hv = server.info?.helperVersion ?? 0;
  if (hv < WFOS_HELPER_VERSION) throw new Refusal(`wfos-app-helper on ${server.name} is version ${hv}, version ${WFOS_HELPER_VERSION} is needed: run the new prepare.sh on the server`);
  // live environments are never held back by previews filling the server's slots
  if (!live && env.status !== "running") {
    const others = await runningAppsOn(server.id, env.id);
    if (others >= server.maxRunningApps) throw new Refusal(`Server ${server.name} already runs ${others} apps (at most ${server.maxRunningApps}); stop one first`);
  }
  // a failure after activate goes back to the running release with its own manifest: it must be known up front
  if (c.current) {
    try {
      c.currentManifest = parseManifest(c.current.manifest);
    } catch {
      throw new Refusal(`The running release ${sha8(c.current.commit)} has no valid stored manifest, so a failed deploy could not be rolled back`);
    }
  }
  if (live) {
    const refusal = await liveDnsRefusal(c);
    if (refusal) throw new Refusal(refusal);
  }

  if (live) c.live = initLiveState(c, { statusBefore: env.status, maintenanceBefore: env.maintenance });
  if (env.maintenance) {
    // left on by a failed restore (or an undo that failed): a release is how it is fixed, so it goes on, and says so
    c.log.line(`note: the maintenance page is on (${env.statusMessage ?? "left by an earlier failure"}): this release replaces it when it switches over; if it fails, the page stays on`);
  }
  await updateEnvironment(env, { status: "deploying", statusMessage: null });
  c.state.appTouched = true;

  const [r] = app.repositoryId ? await db.select().from(repositories).where(and(eq(repositories.id, app.repositoryId), eq(repositories.workspaceId, app.workspaceId))) : [];
  if (!r) throw new DeployInputError("The app has no repository");
  const repo: RepoRef = { id: r.id, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch, token: r.tokenEnc ? decryptSecret(r.tokenEnc) : null };
  c.redactor.add(repo.token);
  try {
    await syncMirror(repo);
  } catch (e) {
    throw new Error(`Could not fetch the repository: ${errorMessage(e).replace(/Authorization: [^\s]+ [^\s]+/g, "Authorization: ***").slice(-500)}`);
  }
  let sha = rel.commit;
  if (!sha) {
    if (!SAFE_REF.test(rel.branch) || rel.branch.startsWith("-") || rel.branch.includes("..")) throw new DeployInputError(`Invalid branch ${rel.branch}`);
    sha = await resolveBranch(c.mirror, rel.branch);
    c.log.line(`branch ${rel.branch} is at ${sha}`);
  }
  await assertCommit(c.mirror, sha);
  c.sha = sha;
  const subject = await commitSubject(c.mirror, sha);
  // a rollback carries the manifest of the release it brings back
  c.manifest = rel.trigger === "rollback" && rel.manifest ? parseManifest(rel.manifest) : await readManifest(c.mirror, sha);
  c.log.line(`commit ${sha} "${subject}"`);
  c.log.line(`manifest: ${JSON.stringify(c.manifest)}`);
  // checks against this server, before anything is sent to it
  if (c.current && sha === c.current.commit && rel.trigger !== "rollback") {
    throw new DeployInputError(`Commit ${sha8(sha)} is the version running now; push a new commit, or stop and start the app to apply changed settings`);
  }
  if (c.manifest.database && !server.info?.postgresPort) {
    throw new DeployInputError(`The app needs a database, but server ${server.name} reports no apps PostgreSQL cluster: run the new prepare.sh on it`);
  }
  const forbidden = forbiddenEnvKeys(extraEnv(env));
  if (forbidden.length) throw new DeployInputError(forbiddenEnvMessage(forbidden));
  const half = Math.floor((server.info?.memTotalMb ?? 0) / 2);
  if (half > 0 && c.manifest.memoryMb > half) {
    throw new DeployInputError(`wfos-app.json asks for memoryMb ${c.manifest.memoryMb}, more than half of server ${server.name}'s memory (${half} MB allowed)`);
  }
  const warnings = await releaseWarnings({
    mirror: c.mirror,
    sha,
    manifest: c.manifest,
    current: c.current ? { commit: c.current.commit, manifest: c.currentManifest } : null,
    hasDatabase: !!env.dbPasswordEnc,
    accessMode: env.accessMode,
  });
  if (warnings.length) c.log.line(`warnings: ${warnings.join(", ")}`);
  if (live) {
    c.log.line(`migrations: ${c.manifest.migrate ? c.manifest.migrations : "none (no migrate command)"}`);
    // "expand" runs while the old version serves and is never undone: its files must only add
    if (c.manifest.migrations === "expand" && c.manifest.migrate && c.current && c.current.commit !== sha && rel.trigger !== "rollback") {
      const v = await expandViolations(c.mirror, c.current.commit, sha);
      if (v.length) throw new DeployInputError(expandRefusalMessage(v));
      c.log.line(`expand check: the migration files changed since ${sha8(c.current.commit)} only add (a best-effort lint of the files, not a proof: an expand migration must stay safe for the old version)`);
    }
  }
  const row = await updateRelease(c.rel, { commit: sha, commitSubject: subject, manifest: c.manifest, warnings });
  if (row) c.rel = row;
}

/** git archive of the commit from the mirror, streamed over SFTP into the server's incoming folder. */
async function upload(c: Ctx): Promise<void> {
  await run(c, "app-init", [c.env.instanceName]);
  const remote = `/home/${c.server.username}/incoming/${c.env.instanceName}-${c.sha}.tar.gz`;
  const git = rootGitSpawn(["-C", c.mirror, "archive", "--format=tar.gz", c.sha]);
  let stderr = "";
  git.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => git.on("close", (code) => resolve(code)));
  let bytes = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) cb(new Error(`the release archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`));
      else cb(null, chunk);
    },
  });
  git.stdout.pipe(capped);
  try {
    await sftpPut(c.target, remote, capped, { mode: 0o640, timeoutMs: 15 * 60_000 });
  } catch (e) {
    git.kill();
    await exited;
    throw e;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git archive failed: ${stderr.trim().slice(-300)}`);
  c.log.line(`uploaded ${(bytes / 1024 / 1024).toFixed(1)} MB to ${remote}`);
}

async function buildRun(c: Ctx, which: "install" | "build" | "migrate", timeoutSec: number, memMb: number, cmd: string): Promise<void> {
  c.log.line(`$ ${cmd}`);
  await run(c, "build-run", [c.env.instanceName, c.sha, which, timeoutSec, memMb], {
    stdin: `${cmd}\n`,
    timeoutMs: (timeoutSec + 120) * 1000,
    maxOutputBytes: 64_000,
    onData: (s) => c.log.write(s),
  });
}

/** Switch `current` to the new release, install its unit, restart. */
async function activate(c: Ctx): Promise<void> {
  const out = await releaseActivate(c, c.sha);
  c.log.line(`previous release on the server: ${out}`);
  await unitInstall(c, c.manifest);
  await run(c, "unit-restart", [c.env.instanceName]);
}

/** `release-activate`; exit 3 means nothing was switched. Returns the previous sha the helper printed. */
async function releaseActivate(c: Ctx, sha: string): Promise<string> {
  // recorded before the call: if the worker dies during it, recovery must assume `current` may have moved
  c.state.activated = true;
  await checkpoint(c, { activated: true });
  try {
    const out = await run(c, "release-activate", [c.env.instanceName, sha]);
    const previous = out.trim().split("\n").pop() ?? "none";
    await checkpoint(c, { previousSha: previous });
    return previous;
  } catch (e) {
    if (e instanceof HelperError && e.exitCode === HELPER_EXIT_GUARD) {
      // a guard refused before anything was switched
      c.state.activated = false;
      await checkpoint(c, { activated: false });
    }
    throw e;
  }
}

/**
 * Rollback trigger: switch back to the release folder if it is still on the server (env, unit, restart). Returns
 * false when the folder is gone (`release_missing`): the caller then builds that commit again.
 */
async function activateExisting(c: Ctx): Promise<boolean> {
  try {
    const out = await releaseActivate(c, c.sha);
    c.log.line(`previous release on the server: ${out}`);
  } catch (e) {
    if (e instanceof HelperError && e.guard === "release_missing") {
      c.log.line(`release ${sha8(c.sha)} is no longer on the server: building it again`);
      return false;
    }
    throw e;
  }
  await installEnv(c, c.sha, c.manifest);
  c.state.envInstalled = true;
  await unitInstall(c, c.manifest);
  await run(c, "unit-restart", [c.env.instanceName]);
  c.log.line("note: a rollback does not restore the database; if this version needs the older schema, restore a backup by hand");
  return true;
}

async function buildAndActivate(c: Ctx): Promise<void> {
  const m = c.manifest;
  await step(c, "upload", () => upload(c));
  await step(c, "unpack", () => run(c, "release-unpack", [c.env.instanceName, c.sha], { timeoutMs: 600_000 }));
  await step(c, "env", async () => {
    await installEnv(c, c.sha, m);
    c.state.envInstalled = true;
  });
  if (m.database) {
    await step(c, "database", async () => {
      const pw = decryptSecret(c.env.dbPasswordEnc!);
      await run(c, "db-create", [c.env.instanceName], { stdin: `${pw}\n` });
    });
  }
  const mem = buildMemory(c.server, BUILD_MEMORY_MB);
  await step(c, "install", () => buildRun(c, "install", INSTALL_TIMEOUT_SEC, mem, m.install));
  await step(c, "build", () => buildRun(c, "build", BUILD_TIMEOUT_SEC, mem, m.build));
  // a migration never runs under the old version: it is stopped first (and started again if this release fails
  // before activate), and the database is dumped while nothing writes to it
  const oldRuns = !!c.current && c.state.appStatusBefore === "running";
  if (m.migrate && c.current && (oldRuns || m.database)) {
    await step(c, "backup", async () => {
      if (oldRuns) {
        c.state.oldStopped = true;
        await run(c, "unit-stop", [c.env.instanceName]);
        c.log.line("maintenance: old version stopped for the migration");
      }
      if (m.database) {
        await run(c, "db-dump", [c.env.instanceName, c.rel.id], { timeoutMs: 600_000 });
        c.state.backup = c.rel.id;
        await updateRelease(c.rel, { dbBackup: c.rel.id });
        // listed with the environment's backups (the preview keeps its dump name: the release id)
        await db
          .insert(appBackups)
          .values({ environmentId: c.env.id, workspaceId: c.env.workspaceId, name: c.rel.id, kind: "pre_migrate", releaseId: c.rel.id, createdBy: c.rel.createdBy })
          .onConflictDoNothing()
          .catch((e: unknown) => log.warn({ err: e, releaseId: c.rel.id }, "backup row not stored"));
      }
    });
  }
  if (m.migrate) {
    const cmd = m.migrate;
    await step(c, "migrate", async () => {
      c.state.migrated = true;
      await checkpoint(c, { migrated: true });
      await buildRun(c, "migrate", MIGRATE_TIMEOUT_SEC, buildMemory(c.server, MIGRATE_MEMORY_MB), cmd);
    });
  }
  await step(c, "activate", () => activate(c));
}

async function healthStep(c: Ctx, m: AppManifest, unit: SlotUnit | null = null): Promise<void> {
  const port = unit ? slotPort(c.env, unit) : c.env.port;
  const h = await waitHealthy(c.target, c.env, m.health, say(c), port);
  if (!h.ok) {
    const state = await unitStatus(c.target, c.env.instanceName, slotFlags(unit));
    throw new Error(`The app did not answer 2xx on ${m.health} within ${Math.round(deployTiming.healthTimeoutMs / 1000)} s (last: ${h.last}; unit ${state})`);
  }
}

async function pipeline(c: Ctx, ws: { killSwitch: boolean; demoMode: boolean }): Promise<void> {
  await step(c, "prepare", () => prepare(c, ws));
  if (c.live) return livePipeline(c);
  const reused = c.rel.trigger === "rollback" && (await step(c, "activate", () => activateExisting(c)));
  if (!reused) await buildAndActivate(c);
  await step(c, "health", () => healthStep(c, c.manifest));
  await step(c, "publish", async () => {
    c.log.write(await publishSite(c.target, c.env, c.redactor));
    if (c.env.kind === "live") {
      // what a later rollback compares the names with (kept in memory too: a later checkpoint write keeps it)
      const publishedNames = liveNames(c.env);
      c.checkpoint = { ...c.checkpoint, publishedNames } as LiveCheckpoint;
      await recordPublishedNames(c.rel.id, publishedNames);
    }
  });
  await step(c, "public_check", () => publicCheck(c.env, c.manifest.health, say(c)));
  await step(c, "cleanup", async () => {
    try {
      await run(c, "release-prune", [c.env.instanceName]);
    } catch (e) {
      // the new version runs and answers: old folders left behind are not a reason to roll back
      c.log.line(`warning: release-prune failed: ${errorMessage(e)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// live: blue-green slots (B2)
// ---------------------------------------------------------------------------

/** The live state at the start of a release (or, in recovery, as it was when the release started). */
function initLiveState(c: Ctx, before: { statusBefore: AppStatus; maintenanceBefore: boolean }): LiveState {
  const cur = c.current;
  const cp = (c.rel.checkpoint ?? null) as LiveCheckpoint | null;
  return {
    oldUnit: cur ? servingUnit(c.env, cur) : null,
    oldServes: !!cur && before.statusBefore === "running" && !before.maintenanceBefore,
    maintenanceBefore: before.maintenanceBefore,
    activeSlotBefore: cur ? slotOfUnit(servingUnit(c.env, cur)) : c.env.activeSlot,
    // recovery: the slot the release had taken; otherwise the idle one
    newUnit: cp?.slot ?? idleSlot(c.env, cur),
    instant: false,
    reused: false,
    breaking: false,
    restoreDb: false,
    maintenanceOn: false,
    newStarted: false,
    switched: false,
  };
}

const unitName = (u: SlotUnit) => (u === "legacy" ? "the single (B1) unit" : `slot ${u}`);

/**
 * Live, after prepare: an instant rollback when the target still runs in its grace unit; otherwise build (or reuse)
 * the release in the idle slot while the old unit serves, migrate (expand: still serving; breaking: maintenance page
 * and old unit stopped), start it on the slot's port, health there, switch nginx, public check.
 */
async function livePipeline(c: Ctx): Promise<void> {
  const L = c.live!;
  const instantTo = c.rel.trigger === "rollback" ? await instantRollbackUnit(c) : null;
  if (instantTo) return instantRollback(c, instantTo);
  let reused = false;
  if (c.rel.trigger === "rollback") {
    await liveBackup(c);
    reused = await step(c, "activate", () => liveActivateExisting(c));
  }
  if (!reused) await liveBuildAndActivate(c);
  await step(c, "health", () => healthStep(c, c.manifest, L.newUnit));
  await step(c, "publish", () => liveSwitch(c));
  await step(c, "public_check", () => publicCheck(c.env, c.manifest.health, say(c)));
  await step(c, "cleanup", async () => {
    try {
      await run(c, "release-prune", [c.env.instanceName]);
    } catch (e) {
      c.log.line(`warning: release-prune failed: ${errorMessage(e)}`);
    }
  });
}

async function liveBuildAndActivate(c: Ctx): Promise<void> {
  const m = c.manifest;
  const L = c.live!;
  await step(c, "upload", () => upload(c));
  await step(c, "unpack", async () => {
    try {
      await run(c, "release-unpack", [c.env.instanceName, c.sha], { timeoutMs: 600_000 });
    } catch (e) {
      // the idle slot still holds this very commit (it ran here before): its folder and build are used as they are
      if (e instanceof HelperError && e.guard === "release_active") {
        L.reused = true;
        c.log.line(`release ${sha8(c.sha)} is already on the server (a slot holds it): its build is used as it is`);
        return;
      }
      throw e;
    }
  });
  await step(c, "env", async () => {
    await installEnv(c, c.sha, m);
    c.state.envInstalled = true;
  });
  if (m.database) {
    await step(c, "database", async () => {
      const pw = decryptSecret(c.env.dbPasswordEnc!);
      await run(c, "db-create", [c.env.instanceName], { stdin: `${pw}\n` });
    });
  }
  if (!L.reused) {
    const mem = buildMemory(c.server, BUILD_MEMORY_MB);
    await step(c, "install", () => buildRun(c, "install", INSTALL_TIMEOUT_SEC, mem, m.install));
    await step(c, "build", () => buildRun(c, "build", BUILD_TIMEOUT_SEC, mem, m.build));
  }
  await liveBackup(c);
  if (m.migrate && c.rel.trigger !== "rollback") {
    const cmd = m.migrate;
    // also for a reused build: migrations are idempotent (SKILL), and a restore since may have taken the schema back
    await step(c, "migrate", async () => {
      c.state.migrated = true;
      await checkpoint(c, { migrated: true });
      c.log.line(L.breaking ? "migrate: the maintenance page is on, nothing else runs" : "migrate: the old version keeps serving (expand)");
      try {
        await buildRun(c, "migrate", MIGRATE_TIMEOUT_SEC, buildMemory(c.server, MIGRATE_MEMORY_MB), cmd);
      } catch (e) {
        if (L.reused && e instanceof HelperError && e.guard === "release_active") {
          throw new Error(`The migration of ${sha8(c.sha)} cannot run: its release folder is a slot's (the helper never runs a command in an active release). Release a new commit, or roll back to it instead`);
        }
        throw e;
      }
    });
  }
  await step(c, "activate", () => liveActivate(c, c.sha));
}

/**
 * The backup step of a live release: ALWAYS a `pre_migrate` dump when the app has a database (refused when it fails),
 * and for a breaking migration while the old version serves, first the maintenance page and the old unit stopped (the
 * dump is then consistent, and nothing writes while it migrates).
 */
async function liveBackup(c: Ctx): Promise<void> {
  const m = c.manifest;
  const L = c.live!;
  const rollback = c.rel.trigger === "rollback";
  const needsDump = m.database && !!c.current && !!c.currentManifest?.database && !c.state.backup;
  L.restoreDb = m.migrations === "breaking";
  const breaking = !rollback && !!m.migrate && m.migrations === "breaking" && L.oldServes && !!L.oldUnit && !c.state.oldStopped;
  if (!needsDump && !breaking) return;
  await step(c, "backup", async () => {
    if (breaking) {
      L.breaking = true;
      // recorded first: a restart from here on brings the old unit back and takes the page down again
      L.maintenanceOn = true;
      await checkpoint(c, { maintenance: true });
      c.log.write(await publishSite(c.target, c.env, c.redactor, { port: slotPort(c.env, L.oldUnit!), maintenance: true }));
      c.env.maintenance = true;
      await updateEnvironment(c.env, { maintenance: true });
      c.state.oldStopped = true;
      await run(c, "unit-stop", [c.env.instanceName, ...slotFlags(L.oldUnit)]);
      // the release before that may still run its grace time: it uses the same database
      const g = pendingGrace(c.current);
      if (g && g.slot !== L.oldUnit) {
        await run(c, "unit-stop", [c.env.instanceName, ...slotFlags(g.slot)]);
        await markGraceDone(c);
      }
      c.log.line(`maintenance: the maintenance page is on and ${unitName(L.oldUnit!)} is stopped for the migration`);
    }
    if (needsDump) {
      try {
        const b = await takeBackup(c.target, c.env, { kind: "pre_migrate", releaseId: c.rel.id, createdBy: c.rel.createdBy, onData: (s) => c.log.write(s) });
        c.state.backup = b.name;
        await updateRelease(c.rel, { dbBackup: b.name });
        c.log.line(`backup: ${b.name}${b.bytes !== null ? ` (${(b.bytes / 1024 / 1024).toFixed(1)} MB)` : ""}`);
      } catch (e) {
        throw new Error(`The database backup failed, so the release is refused: ${errorMessage(e)}`);
      }
    }
  });
}

/** The current release's grace unit is gone (stopped, or taken over by this release). */
async function markGraceDone(c: Ctx): Promise<void> {
  if (!c.current) return;
  await mergeCheckpoint(c.current.id, { graceDone: true });
  c.current.checkpoint = { ...(c.current.checkpoint ?? { appStatusBefore: "running" }), graceDone: true } as LiveCheckpoint;
}

/** `release-activate --slot`, unit-install on the slot's port, (re)start: the new version in the idle slot. */
async function liveActivate(c: Ctx, sha: string): Promise<void> {
  const L = c.live!;
  const slot = L.newUnit as AppSlot;
  const g = pendingGrace(c.current);
  // the idle slot still runs the release before the current one (its grace time): this release takes it over (the
  // grace is settled once release-activate has moved its link)
  const takesOverGrace = g?.slot === slot;
  if (takesOverGrace) c.log.line(`slot ${slot} still runs the release before (grace): it is taken over`);
  else if (g?.slot === "legacy" && slot === "blue") {
    // the B1 unit listens on blue's port: it is stopped (and disabled) before blue starts
    await run(c, "unit-stop", [c.env.instanceName]);
    await markGraceDone(c);
    c.log.line("the single (B1) unit was stopped: blue takes its port");
  }
  // recorded before the call: from here a failure (or recovery) stops this slot again
  c.state.activated = true;
  L.newStarted = true;
  await checkpoint(c, { activated: true, slot, previousSlot: L.oldUnit && L.oldUnit !== "legacy" ? L.oldUnit : null });
  try {
    const out = await run(c, "release-activate", [c.env.instanceName, sha, "--slot", slot]);
    const previous = out.trim().split("\n").pop() ?? "none";
    await checkpoint(c, { previousSha: previous });
    c.log.line(`slot ${slot}: previous release ${previous}`);
    if (takesOverGrace) await markGraceDone(c);
  } catch (e) {
    if (e instanceof HelperError && e.exitCode === HELPER_EXIT_GUARD) {
      // refused before anything was switched: the slot is as it was
      c.state.activated = false;
      L.newStarted = false;
      await checkpoint(c, { activated: false });
    }
    throw e;
  }
  await unitInstall(c, c.manifest, slot);
  await run(c, "unit-restart", [c.env.instanceName, "--slot", slot]);
  c.log.line(`started in slot ${slot} on port ${slotPort(c.env, slot)}`);
}

/** Rollback (not instant): the release folder in the idle slot again, when it is still on the server. */
async function liveActivateExisting(c: Ctx): Promise<boolean> {
  await installEnv(c, c.sha, c.manifest);
  c.state.envInstalled = true;
  try {
    await liveActivate(c, c.sha);
  } catch (e) {
    if (e instanceof HelperError && e.guard === "release_missing") {
      c.log.line(`release ${sha8(c.sha)} is no longer on the server: building it again`);
      return false;
    }
    throw e;
  }
  c.log.line("note: a rollback does not restore the database; if this version needs the older schema, restore a backup");
  return true;
}

/** The switch: nginx to the new unit's port (reload: open connections are not cut), activeSlot, maintenance off. */
async function liveSwitch(c: Ctx): Promise<void> {
  const L = c.live!;
  L.switched = true;
  c.log.write(await publishSite(c.target, c.env, c.redactor, { port: slotPort(c.env, L.newUnit) }));
  L.maintenanceOn = false;
  const activeSlot = slotOfUnit(L.newUnit);
  Object.assign(c.env, { activeSlot, maintenance: false });
  await updateEnvironment(c.env, { activeSlot, maintenance: false });
  c.log.line(`switched: ${c.env.domain} → ${unitName(L.newUnit)} (port ${slotPort(c.env, L.newUnit)})`);
  const publishedNames = liveNames(c.env);
  c.checkpoint = { ...c.checkpoint, publishedNames };
  await recordPublishedNames(c.rel.id, publishedNames);
}

/**
 * Rollback to the release that served right before the current one, while its unit still runs (grace): the target
 * and its unit, or null (then the rollback activates it in the idle slot).
 */
async function instantRollbackUnit(c: Ctx): Promise<SlotUnit | null> {
  const L = c.live!;
  if (!c.current || !L.oldServes) return null;
  const g = pendingGrace(c.current);
  if (!g?.releaseId || g.slot === L.oldUnit) return null;
  let same = g.releaseId === c.rel.rollbackOfId;
  if (!same) {
    const [gr] = await db.select({ commit: appReleases.commit }).from(appReleases).where(eq(appReleases.id, g.releaseId));
    same = gr?.commit === c.sha;
  }
  if (!same) return null;
  const state = await unitStatus(c.target, c.env.instanceName, slotFlags(g.slot));
  if (state !== "active") {
    c.log.line(`${unitName(g.slot)} no longer runs (${state}): the rollback starts it again`);
    return null;
  }
  return g.slot;
}

async function instantRollback(c: Ctx, unit: SlotUnit): Promise<void> {
  const L = c.live!;
  L.instant = true;
  L.newUnit = unit;
  await checkpoint(c, { slot: unit === "legacy" ? undefined : unit, previousSlot: L.oldUnit && L.oldUnit !== "legacy" ? L.oldUnit : null });
  c.log.line(`instant rollback: ${sha8(c.sha)} still runs in ${unitName(unit)} (grace time): nginx goes back to it`);
  await step(c, "health", () => healthStep(c, c.manifest, unit));
  await step(c, "publish", () => liveSwitch(c));
  await step(c, "public_check", () => publicCheck(c.env, c.manifest.health, say(c)));
  await step(c, "cleanup", async () => {
    // the env file is shared by the slots: the one of the version that runs now (it is read at the next start)
    try {
      await installEnv(c, c.sha, c.manifest);
    } catch (e) {
      c.log.line(`warning: env-install failed: ${errorMessage(e)}`);
    }
  });
}

/** A publish whose failure is only logged; true when it went through. */
async function tryPublish(c: Ctx, what: string, port: number, maintenance: boolean): Promise<boolean> {
  try {
    c.log.write(await publishSite(c.target, c.env, c.redactor, { port, maintenance }));
    return true;
  } catch (e) {
    c.log.line(`warning: ${what} failed: ${errorMessage(e)}`);
    return false;
  }
}

/**
 * Undo a live release that failed (or was interrupted): nginx ends on a running unit with the maintenance page off,
 * or the call throws (the caller then shows the maintenance page and tells the Owners).
 * - the old unit kept running (expand, no migration, or nothing switched yet): nginx back to it when it was
 *   switched, the new slot stopped; the database stays (an expand migration only added);
 * - the old unit was stopped for a breaking migration: maintenance page (if switched), new slot stopped, database
 *   restored from the pre_migrate backup (when the migration ran), old unit started, health, nginx back to it;
 * - nothing served before: the new slot stopped (database restored after a breaking migration), the site as it was.
 * Returns the environment patch.
 */
async function liveUndo(c: Ctx, e: unknown): Promise<Partial<typeof appEnvironments.$inferInsert> & { status: AppStatus }> {
  const L = c.live!;
  const inst = c.env.instanceName;
  const cur = c.current;
  const curM = c.currentManifest;
  const code = statusCodeOf(e);
  const restoreDb = c.state.migrated && !!c.state.backup && L.restoreDb;
  const stopNew = async (must: boolean) => {
    if (!L.newStarted) return;
    if (!must) {
      await tryRun(c, "stopping the new version", "unit-stop", [inst, ...slotFlags(L.newUnit)]);
      return;
    }
    try {
      await run(c, "unit-stop", [inst, ...slotFlags(L.newUnit)]);
    } catch (e2) {
      // the helper answered (e.g. the unit was never installed: cut right after release-activate): fine as long as
      // nothing runs there
      if (!(e2 instanceof HelperError) || (await unitStatus(c.target, inst, slotFlags(L.newUnit))) === "active") throw e2;
      c.log.line(`note: ${unitName(L.newUnit)} could not be stopped (${errorMessage(e2)}) but does not run`);
    }
  };
  const restore = async () => {
    await run(c, "db-restore", [inst, c.state.backup!], { timeoutMs: 600_000 });
    c.log.line(`database restored from backup ${c.state.backup}`);
  };
  const envBack = async () => {
    if (!c.state.envInstalled || !cur || !curM) return;
    try {
      await installEnv(c, cur.commit, curM);
    } catch (e2) {
      c.log.line(`warning: putting the running version's env back failed: ${errorMessage(e2)}`);
    }
  };
  c.log.line("==> putting LIVE back");

  if (L.oldServes && L.oldUnit && !c.state.oldStopped) {
    const oldPort = slotPort(c.env, L.oldUnit);
    if (L.switched) {
      c.log.write(await publishSite(c.target, c.env, c.redactor, { port: oldPort }));
      c.log.line(`switched back: ${c.env.domain} → ${unitName(L.oldUnit)} (port ${oldPort})`);
    }
    await stopNew(false);
    await envBack();
    if (c.state.migrated) c.log.line("note: the expand migration stays (the previous version keeps running on the added schema)");
    c.log.line(`<== ${sha8(cur!.commit)} keeps serving`);
    return { status: "running", statusMessage: code, maintenance: false, activeSlot: slotOfUnit(L.oldUnit) };
  }

  if (L.oldServes && L.oldUnit && c.state.oldStopped) {
    const oldPort = slotPort(c.env, L.oldUnit);
    if (L.switched) {
      c.log.write(await publishSite(c.target, c.env, c.redactor, { port: oldPort, maintenance: true }));
      L.maintenanceOn = true;
      await updateEnvironment(c.env, { maintenance: true });
    }
    // never a restore while a version runs on the database
    await stopNew(true);
    if (restoreDb) await restore();
    await envBack();
    await run(c, "unit-start", [inst, ...slotFlags(L.oldUnit)]);
    const h = await waitHealthy(c.target, c.env, curM!.health, say(c), oldPort);
    if (!h.ok) throw new Error(`the previous version did not answer 2xx on ${curM!.health} after it was started again (last: ${h.last}; unit ${await unitStatus(c.target, inst, slotFlags(L.oldUnit))})`);
    c.log.write(await publishSite(c.target, c.env, c.redactor, { port: oldPort }));
    L.maintenanceOn = false;
    c.log.line(`<== maintenance over: ${sha8(cur!.commit)} runs again in ${unitName(L.oldUnit)}`);
    return { status: "running", healthy: true, lastHealthAt: new Date(), statusMessage: code, maintenance: false, activeSlot: slotOfUnit(L.oldUnit) };
  }

  // nothing served when the release started (first release, stopped, or behind the maintenance page)
  if (restoreDb) {
    await stopNew(true);
    await restore();
  } else await stopNew(false);
  const keepMaintenance = L.maintenanceBefore && !!L.oldUnit;
  if (L.switched) {
    if (keepMaintenance) {
      if (!(await tryPublish(c, "showing the maintenance page again", slotPort(c.env, L.oldUnit!), true))) throw new Error("the maintenance page could not be put back");
    } else await tryRun(c, "unpublishing the site", "unpublish", [inst]);
  }
  await envBack();
  return {
    status: cur ? statusWithoutChange(c.env, c.state.appStatusBefore) : "failed",
    ...(cur ? {} : { healthy: false }),
    statusMessage: code,
    // nginx untouched (never switched): the flag as it was; switched: what was published back just now
    maintenance: L.switched ? keepMaintenance : L.maintenanceBefore,
    activeSlot: L.activeSlotBefore,
  };
}

// ---------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------

async function actor(userId: string | null): Promise<{ actorUserId: string | null; actorLabel: string }> {
  if (!userId) return { actorUserId: null, actorLabel: "system" };
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return { actorUserId: userId, actorLabel: u?.email ?? "system" };
}

async function auditRelease(c: Pick<Ctx, "rel" | "app" | "env" | "sha">, action: string, details: Record<string, unknown>): Promise<void> {
  await audit({
    workspaceId: c.app.workspaceId,
    ...(await actor(c.rel.createdBy)),
    action,
    targetType: "app",
    targetId: c.app.id,
    details: { releaseId: c.rel.id, environmentId: c.env.id, environment: c.env.kind, commit: c.sha || null, branch: c.rel.branch, trigger: c.rel.trigger, ...details },
  });
}

async function succeed(c: Ctx): Promise<ReleaseStatus> {
  const now = new Date();
  const L = c.live;
  // live: the unit that served before keeps running for the grace time (an instant rollback), then it is stopped
  const graceUnit = L && L.oldServes && L.oldUnit && !c.state.oldStopped && L.oldUnit !== L.newUnit ? L.oldUnit : null;
  if (L) {
    await checkpoint(c, {
      graceSlot: graceUnit,
      graceReleaseId: graceUnit ? (c.current?.id ?? null) : null,
      graceUntil: graceUnit ? new Date(now.getTime() + GRACE_MS).toISOString() : null,
      graceDone: !graceUnit,
    });
  }
  const superseded = await db.transaction(async (tx) => {
    const old = await tx
      .update(appReleases)
      .set({ status: "superseded" })
      .where(and(eq(appReleases.environmentId, c.env.id), eq(appReleases.status, "deployed"), ne(appReleases.id, c.rel.id)))
      .returning();
    await tx.update(appReleases).set({ status: "deployed", step: "cleanup", error: null, finishedAt: now }).where(eq(appReleases.id, c.rel.id));
    await tx
      .update(appEnvironments)
      .set({
        currentReleaseId: c.rel.id,
        status: "running",
        healthy: true,
        lastDeployedAt: now,
        lastHealthAt: now,
        memoryMb: c.manifest.memoryMb,
        statusMessage: null,
        // the site was published just now: no maintenance page (also one a failed restore had left on)
        maintenance: false,
        ...(L ? { activeSlot: slotOfUnit(L.newUnit) } : {}),
        updatedAt: now,
      })
      .where(eq(appEnvironments.id, c.env.id));
    return old;
  });
  for (const r of superseded) await publishRelease(r);
  await publishRelease({ ...c.rel, status: "deployed", step: "cleanup" });
  await publish(c.app.workspaceId, { type: "app.updated", appId: c.app.id, status: "running", environmentId: c.env.id });
  c.log.line(`deployed ${c.sha} at ${appUrl(c.env)}`);
  if (L && !graceUnit && L.oldUnit && L.oldUnit !== L.newUnit && !c.state.oldStopped && !L.instant) {
    // the old unit did not serve (stopped, or behind the maintenance page): nothing to keep it running for
    await tryRun(c, `stopping ${unitName(L.oldUnit)}`, "unit-stop", [c.env.instanceName, ...slotFlags(L.oldUnit)]);
  }
  if (graceUnit && L) {
    c.log.line(`grace: ${unitName(graceUnit)} keeps running ${APP_LIVE_GRACE_SECONDS} s (an instant rollback), then it is stopped`);
    await queueGraceStop({ appId: c.app.id, workspaceId: c.app.workspaceId, environmentId: c.env.id, releaseId: c.rel.id, slot: graceUnit }, GRACE_MS).catch((e: unknown) =>
      // the sweep (apps tick, worker start) queues it again from the checkpoint
      log.warn({ err: e, releaseId: c.rel.id }, "grace stop could not be queued"),
    );
  }
  await auditRelease(c, "app.deployed", { warnings: c.rel.warnings });
  // a preview a task asked for is announced by that task (done, with the URL): one notification, not two; a LIVE
  // release is always announced to the Owner who started or approved it
  if (!c.rel.taskId || c.env.kind === "live") await notifyApp({
    workspaceId: c.app.workspaceId,
    appId: c.app.id,
    userId: c.rel.createdBy,
    kind: "task_done",
    subject: appMsg(c.locale, c.env.kind === "live" ? "app.deployedLive" : "app.deployed", { name: envLabel(c.app, c.env) }),
    text: appMsg(c.locale, "app.deployedText", { name: envLabel(c.app, c.env), commit: sha8(c.sha), subject: c.redactor.apply(c.rel.commitSubject ?? ""), url: appUrl(c.env) }),
  });
  return "deployed";
}

/** Bring the release that ran before back: folder, env, unit, database (when migrated), health, site. */
async function rollbackToCurrent(c: Ctx, cur: Release, m: AppManifest): Promise<void> {
  c.log.line(`==> rollback to ${cur.commit}`);
  await run(c, "release-activate", [c.env.instanceName, cur.commit]);
  await installEnv(c, cur.commit, m);
  await unitInstall(c, m);
  if (c.state.migrated && c.state.backup) {
    await run(c, "unit-stop", [c.env.instanceName]);
    await run(c, "db-restore", [c.env.instanceName, c.state.backup], { timeoutMs: 600_000 });
    c.log.line(`database restored from backup ${c.state.backup}`);
  }
  await run(c, "unit-restart", [c.env.instanceName]);
  const h = await waitHealthy(c.target, c.env, m.health, say(c));
  if (!h.ok) throw new Error(`the previous version did not answer 2xx on ${m.health} either (last: ${h.last}; unit ${await unitStatus(c.target, c.env.instanceName)})`);
  c.log.write(await publishSite(c.target, c.env, c.redactor));
  c.log.line(`<== rollback done: ${cur.commit} runs again`);
}

/** Best effort: a helper command whose failure is only logged. */
async function tryRun(c: Ctx, what: string, cmd: string, args: (string | number)[], o: HelperOptions = {}): Promise<boolean> {
  try {
    await run(c, cmd, args, o);
    return true;
  } catch (e) {
    c.log.line(`warning: ${what} failed: ${errorMessage(e)}`);
    return false;
  }
}

async function fail(c: Ctx, e: unknown): Promise<ReleaseStatus> {
  const error = c.redactor.apply(errorMessage(e)).slice(0, 1000);
  const step = c.state.step;
  const now = new Date();
  const notifyFailed = async (nothingRuns: boolean, details: Record<string, unknown>) => {
    await auditRelease(c, "app.deploy_failed", { step, error: error.slice(0, 500), ...details });
    await notifyApp({
      workspaceId: c.app.workspaceId,
      appId: c.app.id,
      userId: c.rel.createdBy,
      kind: "task_failed",
      subject: appMsg(c.locale, "app.deployFailed", { name: envLabel(c.app, c.env) }),
      text: appMsg(c.locale, "app.deployFailedText", {
        commit: c.sha ? sha8(c.sha) : c.rel.branch,
        step,
        error: error.slice(0, 300),
        state: appMsg(c.locale, nothingRuns ? "app.stateNothingRuns" : "app.stateOldRuns"),
      }),
    });
  };
  log.warn({ releaseId: c.rel.id, appId: c.app.id, step, err: error }, "release failed");

  if (!c.state.appTouched) {
    // refused before anything happened: the app is left as it was
    await updateRelease(c.rel, { status: "failed", step, error, finishedAt: now });
    await publish(c.app.workspaceId, { type: "app.updated", appId: c.app.id, status: c.env.status, environmentId: c.env.id });
    await notifyFailed(c.env.status !== "running", { refused: true });
    return "failed";
  }

  if (c.live) return liveFail(c, e, error, notifyFailed);

  if (!c.state.activated) {
    // the old version's folder was never switched; undo what the failed release changed beside it. The database is
    // only restored while no version runs (the old one was stopped for the migration), then the old one starts again.
    if (c.state.migrated && c.state.backup) {
      if (await tryRun(c, "restoring the database", "db-restore", [c.env.instanceName, c.state.backup], { timeoutMs: 600_000 })) c.log.line(`database restored from backup ${c.state.backup}`);
    }
    if (c.state.envInstalled && c.current && c.currentManifest) {
      const cur = c.current;
      const m = c.currentManifest;
      try {
        await installEnv(c, cur.commit, m);
      } catch (e2) {
        c.log.line(`warning: putting the running version's env back failed: ${errorMessage(e2)}`);
      }
    }
    let status = statusWithoutChange(c.env, c.state.appStatusBefore);
    // firewall_off / server_full: the reason the app shows (an Owner has to act on the server)
    let statusMessage: string | null = statusCodeOf(e);
    if (c.state.oldStopped) {
      if (await tryRun(c, "starting the old version again", "unit-start", [c.env.instanceName])) c.log.line("maintenance over: the old version runs again");
      else {
        status = "failed";
        statusMessage = statusMessage ?? "restart_failed";
      }
    }
    await updateRelease(c.rel, { status: "failed", step, error, finishedAt: now });
    await updateEnvironment(c.env, { status, statusMessage });
    await notifyFailed(status !== "running", {});
    return "failed";
  }

  const cur = c.current;
  if (cur) {
    try {
      await rollbackToCurrent(c, cur, c.currentManifest!);
      await updateRelease(c.rel, { status: "rolled_back", step, error, finishedAt: now });
      await updateEnvironment(c.env, { status: "running", healthy: true, lastHealthAt: new Date(), statusMessage: null, maintenance: false });
      await auditRelease(c, "app.rolled_back", { step, error: error.slice(0, 500), restoredCommit: cur.commit, databaseRestored: !!(c.state.migrated && c.state.backup) });
      await notifyApp({
        workspaceId: c.app.workspaceId,
        appId: c.app.id,
        userId: c.rel.createdBy,
        kind: "task_failed",
        subject: appMsg(c.locale, "app.rolledBack", { name: envLabel(c.app, c.env) }),
        text: appMsg(c.locale, "app.rolledBackText", { commit: sha8(c.sha), step, error: error.slice(0, 300), previous: sha8(cur.commit), url: appUrl(c.env) }),
      });
      return "rolled_back";
    } catch (e2) {
      const error2 = c.redactor.apply(errorMessage(e2)).slice(0, 500);
      c.log.line(`<== rollback FAILED: ${errorMessage(e2)}`);
      await updateRelease(c.rel, { status: "failed", step, error: `${error} — rolling back to ${sha8(cur.commit)} failed too: ${error2}`.slice(0, 1500), finishedAt: now });
      await updateEnvironment(c.env, { status: "failed", healthy: false, statusMessage: statusCodeOf(e2) ?? statusCodeOf(e) ?? "rollback_failed" });
      await notifyFailed(true, { rollbackFailed: true, rollbackError: error2 });
      return "failed";
    }
  }

  // first version (nothing to go back to): take it off the air
  await tryRun(c, "stopping the app", "unit-stop", [c.env.instanceName]);
  await tryRun(c, "unpublishing the site", "unpublish", [c.env.instanceName]);
  await updateRelease(c.rel, { status: "failed", step, error, finishedAt: now });
  await updateEnvironment(c.env, { status: "failed", healthy: false, statusMessage: statusCodeOf(e) });
  await notifyFailed(true, { stopped: true });
  return "failed";
}

/** The outcome of a failed live release: undone (liveUndo), or — when that fails too — the maintenance page and the Owners told. */
async function liveFail(c: Ctx, e: unknown, error: string, notifyFailed: (nothingRuns: boolean, details: Record<string, unknown>) => Promise<void>): Promise<ReleaseStatus> {
  const L = c.live!;
  const step = c.state.step;
  const now = new Date();
  const cur = c.current;
  try {
    const patch = await liveUndo(c, e);
    // rolled_back = it was switched on and the previous version serves again; anything else failed
    const status: ReleaseStatus = L.switched && cur && patch.status === "running" ? "rolled_back" : "failed";
    await updateRelease(c.rel, { status, step, error, finishedAt: now });
    await updateEnvironment(c.env, patch);
    if (status === "rolled_back" && cur) {
      await auditRelease(c, "app.rolled_back", { step, error: error.slice(0, 500), restoredCommit: cur.commit, databaseRestored: !!(c.state.migrated && c.state.backup && L.restoreDb), instant: L.instant });
      await notifyApp({
        workspaceId: c.app.workspaceId,
        appId: c.app.id,
        userId: c.rel.createdBy,
        kind: "task_failed",
        subject: appMsg(c.locale, "app.rolledBack", { name: envLabel(c.app, c.env) }),
        text: appMsg(c.locale, "app.rolledBackText", { commit: sha8(c.sha), step, error: error.slice(0, 300), previous: sha8(cur.commit), url: appUrl(c.env) }),
      });
    } else await notifyFailed(patch.status !== "running", { databaseRestored: !!(c.state.migrated && c.state.backup && L.restoreDb) });
    return status;
  } catch (e2) {
    const error2 = c.redactor.apply(errorMessage(e2)).slice(0, 500);
    c.log.line(`<== putting LIVE back FAILED: ${errorMessage(e2)}`);
    // nothing is known to answer: visitors get the maintenance page rather than an error
    const port = L.oldUnit ? slotPort(c.env, L.oldUnit) : slotPort(c.env, L.newUnit);
    const maintenance = cur ? await tryPublish(c, "showing the maintenance page", port, true) : false;
    if (!cur) await tryRun(c, "unpublishing the site", "unpublish", [c.env.instanceName]);
    await updateRelease(c.rel, { status: "failed", step, error: `${error} — putting the previous version back failed too: ${error2}`.slice(0, 1500), finishedAt: now });
    await updateEnvironment(c.env, { status: "failed", healthy: false, maintenance, statusMessage: statusCodeOf(e2) ?? statusCodeOf(e) ?? "rollback_failed" });
    await notifyFailed(true, { rollbackFailed: true, rollbackError: error2, maintenance });
    await notifyOwners({
      workspaceId: c.app.workspaceId,
      appId: c.app.id,
      kind: "incident",
      subject: appMsg(c.locale, "app.liveAttention", { name: envLabel(c.app, c.env) }),
      text: appMsg(c.locale, "app.liveAttentionText", {
        commit: c.sha ? sha8(c.sha) : c.rel.branch,
        step,
        error: error.slice(0, 300),
        error2: error2.slice(0, 300),
        state: appMsg(c.locale, maintenance ? "app.stateMaintenance" : "app.stateUnknown"),
      }),
    });
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

type Loaded = { c: Ctx; ws: { killSwitch: boolean; demoMode: boolean } } | { error: string };

/** Everything a release needs (rows, SSH target, log); an error message when something is missing. */
async function loadContext(rel: Release, workspaceId: string): Promise<Loaded> {
  const [app] = await db.select().from(apps).where(and(eq(apps.id, rel.appId), eq(apps.workspaceId, workspaceId)));
  if (!app) return { error: "The app no longer exists" };
  const [env] = await db
    .select()
    .from(appEnvironments)
    .where(and(eq(appEnvironments.id, rel.environmentId), eq(appEnvironments.appId, app.id), eq(appEnvironments.workspaceId, workspaceId)));
  if (!env) return { error: "The app's environment no longer exists" };
  const [server] = await db.select().from(servers).where(and(eq(servers.id, env.serverId), eq(servers.workspaceId, workspaceId)));
  if (!server) return { error: "The app's server no longer exists" };
  if (!app.repositoryId) return { error: "The app has no repository" };
  const [ws] = await db.select({ killSwitch: workspaces.killSwitch, demoMode: workspaces.demoMode, locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) return { error: "The workspace no longer exists" };
  const target = await sshTarget(server);
  if (!target) return { error: "The workspace has no SSH key, or the server has no pinned host key" };
  const [current] = env.currentReleaseId ? await db.select().from(appReleases).where(and(eq(appReleases.id, env.currentReleaseId), eq(appReleases.environmentId, env.id))) : [];
  const redactor = new Redactor();
  seedRedactor(env, redactor);
  const c: Ctx = {
    rel,
    app,
    env,
    server,
    target,
    mirror: mirrorPath(app.repositoryId),
    locale: ws.locale,
    sha: "",
    manifest: null as unknown as AppManifest,
    current: current ?? null,
    currentManifest: null,
    log: new ReleaseLog(rel.id, redactor, deployTiming.logFlushMs, rel.log),
    redactor,
    state: { step: "prepare", appTouched: false, appStatusBefore: env.status, envInstalled: false, migrated: false, backup: null, activated: false, oldStopped: false },
    checkpoint: (rel.checkpoint ?? { appStatusBefore: env.status }) as LiveCheckpoint,
    live: null,
  };
  return { c, ws };
}

/** Store the outcome; never leave the release "deploying" (also when storing it fails). */
async function settle(c: Ctx, error: unknown): Promise<ReleaseStatus> {
  try {
    return error === null ? await succeed(c) : await fail(c, error);
  } catch (e) {
    log.error({ err: e, releaseId: c.rel.id }, "release outcome could not be stored");
    await updateRelease(c.rel, { status: "failed", error: c.redactor.apply(`Internal error: ${errorMessage(e)}`).slice(0, 1000), finishedAt: new Date() }).catch(() => null);
    return "failed";
  } finally {
    await c.log.close().catch((e) => log.warn({ err: e, releaseId: c.rel.id }, "release log could not be stored"));
  }
}

/**
 * Run one queued release (deploy or rollback) start to end. Only a `queued` release is taken (claimed atomically),
 * so a duplicate job or a second worker does nothing. Returns the final status, or null when there was nothing to do.
 */
export async function runRelease(releaseId: string, workspaceId: string): Promise<ReleaseStatus | null> {
  const startedAt = new Date();
  const [rel] = await db
    .update(appReleases)
    .set({ status: "deploying", step: "prepare", startedAt, error: null })
    .where(and(eq(appReleases.id, releaseId), eq(appReleases.workspaceId, workspaceId), eq(appReleases.status, "queued")))
    .returning();
  if (!rel) {
    log.info({ releaseId }, "release skipped: not queued");
    return null;
  }
  let loaded: Loaded;
  try {
    await publishRelease(rel);
    loaded = await loadContext(rel, workspaceId);
  } catch (e) {
    loaded = { error: `Internal error: ${errorMessage(e)}` };
  }
  if ("error" in loaded) {
    await updateRelease(rel, { status: "failed", error: loaded.error.slice(0, 1000), finishedAt: new Date() }).catch((e) => log.error({ err: e, releaseId }, "release could not be failed"));
    await handBack(rel.id);
    return "failed";
  }
  const { c, ws } = loaded;
  c.log.line(`release ${rel.id} (${rel.trigger}) of ${c.env.instanceName} (${c.env.kind}) on ${c.server.name}, branch ${rel.branch}${rel.commit ? `, commit ${rel.commit}` : ""}, ${startedAt.toISOString()}`);
  let error: unknown = null;
  try {
    await checkpoint(c, { appStatusBefore: c.env.status });
    await pipeline(c, ws);
  } catch (e) {
    error = e;
  }
  const status = await settle(c, error);
  await handBack(rel.id);
  return status;
}

/**
 * A release a task asked for (request_preview) hands its outcome back to that task once it is stored: deliverable +
 * DONE, or the task goes back to the Developer with the log tail (afterReleaseSettled). Never throws: the release
 * itself is settled either way, and the reaper picks a stuck task up later.
 */
export async function handBack(releaseId: string): Promise<void> {
  await afterReleaseSettled(releaseId).catch((e: unknown) => log.error({ err: e, releaseId }, "preview outcome could not be handed back to its task"));
}

const stepAtLeast = (s: ReleaseStep | null, than: ReleaseStep) => !!s && stepIndex(s) >= stepIndex(than);

/**
 * A release left `deploying` by a worker that stopped (worker start, before any job runs). When it had switched
 * `current`, migrated, or stopped the old version for its migration, it is undone like a live failure (rollback,
 * database restore, old version started again), which needs the server; an unreachable server leaves the app
 * `failed` with statusMessage "interrupted". Otherwise only the rows are settled: the release failed
 * ("interrupted"), the app back to the status it had before.
 */
export async function settleInterrupted(rel: Release, reason: "interrupted" | "lost" = "interrupted"): Promise<ReleaseStatus> {
  const status = await settleInterruptedRows(rel, reason);
  await handBack(rel.id);
  return status;
}

async function settleInterruptedRows(rel: Release, reason: string): Promise<ReleaseStatus> {
  const cp = rel.checkpoint;
  let manifest: AppManifest | null = null;
  try {
    manifest = rel.manifest ? parseManifest(rel.manifest) : null;
  } catch {
    manifest = null;
  }
  const loaded = await loadContext(rel, rel.workspaceId).catch((e: unknown) => ({ error: errorMessage(e) }) as Loaded);
  const env = "error" in loaded ? null : loaded.c.env;
  const before: AppStatus = cp?.appStatusBefore ?? (env ? statusWithoutChange(env, "deploying") : "failed");
  const live = env?.kind === "live";
  const lcp = cp as LiveCheckpoint | null;
  // live: nginx may point at the new slot from the publish step on; the old unit was stopped only for a breaking
  // migration, which switched the maintenance page on first (checkpoint.maintenance)
  const switched = live && stepAtLeast(rel.step, "publish");
  const oldStopped = live
    ? !!lcp?.maintenance
    : !!manifest?.migrate && before === "running" && !!env?.currentReleaseId && stepAtLeast(rel.step, "backup") && !cp?.activated;
  const touchedServer = !!cp?.activated || !!cp?.migrated || oldStopped || switched;
  const tellOwners = async () => {
    if (!live || "error" in loaded) return;
    const { c } = loaded;
    await notifyOwners({
      workspaceId: rel.workspaceId,
      appId: rel.appId,
      kind: "incident",
      subject: appMsg(c.locale, "app.liveAttention", { name: envLabel(c.app, c.env) }),
      text: appMsg(c.locale, "app.liveInterruptedText", { commit: rel.commit ? sha8(rel.commit) : rel.branch, step: rel.step ?? "prepare", state: appMsg(c.locale, "app.stateUnknown") }),
    }).catch((e: unknown) => log.warn({ err: e, releaseId: rel.id }, "owners could not be told about an interrupted live release"));
  };

  const settleRows = async (appPatch: { status: AppStatus; statusMessage?: string | null } | null) => {
    const [row] = await db.update(appReleases).set({ status: "failed", error: reason, finishedAt: new Date() }).where(eq(appReleases.id, rel.id)).returning();
    if (row) await publishRelease(row);
    if (env && appPatch && env.status === "deploying") await updateEnvironment(env, appPatch);
    await audit({
      workspaceId: rel.workspaceId,
      actorLabel: "system",
      action: "app.deploy_failed",
      targetType: "app",
      targetId: rel.appId,
      details: { releaseId: rel.id, environmentId: rel.environmentId, commit: rel.commit || null, branch: rel.branch, trigger: rel.trigger, step: rel.step, error: reason },
    });
    return "failed" as const;
  };

  if ("error" in loaded || !touchedServer || !manifest || !rel.commit) {
    if (touchedServer) return settleRows({ status: "failed", statusMessage: "interrupted" });
    return settleRows({ status: before === "deploying" ? statusWithoutChange(env ?? { currentReleaseId: null }, "deploying") : before });
  }
  const { c } = loaded;
  c.sha = rel.commit;
  c.manifest = manifest;
  if (c.current) {
    try {
      c.currentManifest = parseManifest(c.current.manifest);
    } catch {
      c.currentManifest = null;
    }
  }
  c.state = {
    step: rel.step ?? "prepare",
    appTouched: true,
    appStatusBefore: before,
    envInstalled: stepAtLeast(rel.step, "env"),
    migrated: !!cp?.migrated,
    backup: rel.dbBackup,
    activated: !!cp?.activated,
    oldStopped,
  };
  if (live) {
    // the maintenance flag this release set is not the state before it
    const maintenanceBefore = c.env.maintenance && !lcp?.maintenance;
    c.live = initLiveState(c, { statusBefore: before, maintenanceBefore });
    c.live.newStarted = !!cp?.activated;
    c.live.switched = switched;
    c.live.maintenanceOn = !!lcp?.maintenance;
    c.live.breaking = !!lcp?.maintenance;
    c.live.restoreDb = manifest.migrations === "breaking";
  }
  // the server must answer before anything is undone on it
  try {
    await helperCall(c.target, "unit-status", [c.env.instanceName], { timeoutMs: 30_000 });
  } catch (e) {
    log.warn({ releaseId: rel.id, err: errorMessage(e) }, "interrupted release: server not reachable, nothing undone");
    await c.log.close().catch(() => null);
    const out = await settleRows({ status: "failed", statusMessage: "interrupted" });
    await tellOwners();
    return out;
  }
  if (c.live) {
    // what the server itself says (helper v4 `slots`) beats what the checkpoint could record before the cut
    const L = c.live;
    const view = await readSlots(c.target, c.env.instanceName);
    if (view) {
      c.log.line(`server: ${JSON.stringify(view)}`);
      const newPort = slotPort(c.env, L.newUnit);
      const oldPort = L.oldUnit ? slotPort(c.env, L.oldUnit) : null;
      if (view.site && view.site.port === newPort && oldPort !== newPort && !view.site.maintenance) L.switched = true;
      const old = L.oldUnit ? view[L.oldUnit] : null;
      // the old unit no longer runs (stopped for a migration, or crashed): the undo starts it again
      if (L.oldServes && old && old.state !== "active") c.state.oldStopped = true;
      // nginx already serves this release from its own slot and the unit runs it: when it answers, the release is
      // finished (cleanup, deployed), never undone
      const mine = view[L.newUnit];
      if (view.site && !view.site.maintenance && view.site.port === newPort && oldPort !== newPort && mine?.state === "active" && mine.sha === rel.commit) {
        const h = await waitHealthy(c.target, c.env, manifest.health, say(c), newPort);
        if (h.ok) {
          c.log.line(`${reason} at ${rel.step ?? "prepare"}, but ${c.env.domain} already runs it from ${unitName(L.newUnit)} and it answers: finishing it`);
          L.switched = true;
          L.newStarted = true;
          L.maintenanceOn = false;
          await tryRun(c, "release-prune", "release-prune", [c.env.instanceName]);
          return settle(c, null);
        }
        c.log.line(`it does not answer on ${unitName(L.newUnit)} (${h.last}): undoing it`);
      }
    }
  }
  c.log.line(`${reason} at ${rel.step ?? "prepare"} (the worker stopped): undoing it`);
  return settle(c, new Error(reason));
}
