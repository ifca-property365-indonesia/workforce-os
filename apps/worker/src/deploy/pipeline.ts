import { Transform } from "node:stream";
import { and, eq, inArray, ne } from "drizzle-orm";
import { appEnvironments, apps, appReleases, audit, db, repositories, servers, tasks, users, workspaces } from "@wfos/db";
import { RELEASE_STEPS, WFOS_HELPER_VERSION, type AppManifest, type AppStatus, type ReleaseCheckpoint, type ReleaseStatus, type ReleaseStep } from "@wfos/shared";
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
import { assertCommit, commitSubject, DeployInputError, parseManifest, readManifest, releaseWarnings, resolveBranch } from "./manifest";
import { appMsg } from "./messages";
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
  checkpoint: ReleaseCheckpoint;
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
async function checkpoint(c: Ctx, patch: Partial<ReleaseCheckpoint>): Promise<void> {
  c.checkpoint = { ...c.checkpoint, ...patch };
  await db.update(appReleases).set({ checkpoint: c.checkpoint }).where(eq(appReleases.id, c.rel.id));
}

/** Memory for a build-run: `want`, capped at half the server's memory (the helper refuses more). */
function buildMemory(s: Server, want: number): number {
  const half = Math.floor((s.info?.memTotalMb ?? 0) / 2);
  return Math.max(256, half > 0 ? Math.min(want, half) : want);
}

async function unitInstall(c: Ctx, m: AppManifest): Promise<void> {
  await run(c, "unit-install", [c.env.instanceName, c.env.port, m.memoryMb, ...(m.database ? ["--database"] : [])], { stdin: `${m.start}\n` });
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

/** Refusals, then the commit, its manifest and the warnings. */
async function prepare(c: Ctx, ws: { killSwitch: boolean; demoMode: boolean }): Promise<void> {
  const { rel, app, env, server } = c;
  const live = env.kind === "live";
  if (ws.killSwitch) throw new Refusal("The kill switch is engaged: nothing is deployed");
  const [task] = rel.taskId ? await db.select({ dryRun: tasks.dryRun }).from(tasks).where(eq(tasks.id, rel.taskId)) : [];
  if (ws.demoMode || task?.dryRun) throw new Refusal("Dry run: nothing is deployed");
  if (live) {
    // agents publish previews only; LIVE is an Owner's decision (with step-up on the web)
    if (rel.taskId || rel.approvalId || rel.trigger === "approval") throw new Refusal("A task cannot release to LIVE: an Owner releases a checked preview");
    if (!(await isOwner(c.app.workspaceId, c.rel.createdBy))) throw new Refusal("Only an Owner of the workspace can release to LIVE");
    if (!rel.commit) throw new Refusal("A LIVE release names the commit it brings (a release of the preview)");
    const refusal = await livePromotionRefusal(c, rel.commit);
    if (refusal) throw new Refusal(refusal);
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

async function healthStep(c: Ctx, m: AppManifest): Promise<void> {
  const h = await waitHealthy(c.target, c.env, m.health, say(c));
  if (!h.ok) {
    const unit = await unitStatus(c.target, c.env.instanceName);
    throw new Error(`The app did not answer 2xx on ${m.health} within ${Math.round(deployTiming.healthTimeoutMs / 1000)} s (last: ${h.last}; unit ${unit})`);
  }
}

async function pipeline(c: Ctx, ws: { killSwitch: boolean; demoMode: boolean }): Promise<void> {
  await step(c, "prepare", () => prepare(c, ws));
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
  const superseded = await db.transaction(async (tx) => {
    const old = await tx
      .update(appReleases)
      .set({ status: "superseded" })
      .where(and(eq(appReleases.environmentId, c.env.id), eq(appReleases.status, "deployed"), ne(appReleases.id, c.rel.id)))
      .returning();
    await tx.update(appReleases).set({ status: "deployed", step: "cleanup", error: null, finishedAt: now }).where(eq(appReleases.id, c.rel.id));
    await tx
      .update(appEnvironments)
      .set({ currentReleaseId: c.rel.id, status: "running", healthy: true, lastDeployedAt: now, lastHealthAt: now, memoryMb: c.manifest.memoryMb, statusMessage: null, updatedAt: now })
      .where(eq(appEnvironments.id, c.env.id));
    return old;
  });
  for (const r of superseded) await publishRelease(r);
  await publishRelease({ ...c.rel, status: "deployed", step: "cleanup" });
  await publish(c.app.workspaceId, { type: "app.updated", appId: c.app.id, status: "running", environmentId: c.env.id });
  c.log.line(`deployed ${c.sha} at ${appUrl(c.env)}`);
  await auditRelease(c, "app.deployed", { warnings: c.rel.warnings });
  // a preview a task asked for is announced by that task (done, with the URL): one notification, not two
  if (!c.rel.taskId) await notifyApp({
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
      await updateEnvironment(c.env, { status: "running", healthy: true, lastHealthAt: new Date(), statusMessage: null });
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
    checkpoint: rel.checkpoint ?? { appStatusBefore: env.status },
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
  const oldStopped = !!manifest?.migrate && before === "running" && !!env?.currentReleaseId && stepAtLeast(rel.step, "backup") && !cp?.activated;
  const touchedServer = !!cp?.activated || !!cp?.migrated || oldStopped;

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
  // the server must answer before anything is undone on it
  try {
    await helperCall(c.target, "unit-status", [c.env.instanceName], { timeoutMs: 30_000 });
  } catch (e) {
    log.warn({ releaseId: rel.id, err: errorMessage(e) }, "interrupted release: server not reachable, nothing undone");
    await c.log.close().catch(() => null);
    return settleRows({ status: "failed", statusMessage: "interrupted" });
  }
  c.log.line(`${reason} at ${rel.step ?? "prepare"} (the worker stopped): undoing it`);
  return settle(c, new Error(reason));
}
