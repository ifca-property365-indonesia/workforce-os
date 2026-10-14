import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appEnvironments, appReleases, audit, db } from "@wfos/db";
import { appDeploySchema, isWithinReleaseWindow } from "@wfos/shared";
import { HttpError } from "@/lib/server/auth";
import { nextReleaseWindowOpening } from "@/lib/release-window";
import {
  activeRelease,
  assertNoRestore,
  assertDeploysAllowed,
  assertNotRemoving,
  assertServerReady,
  isUuid,
  loadAppEnv,
  loadEnv,
  releaseDTO,
  requireLiveOwner,
  ROLLBACK_SOURCE_STATUSES,
} from "@/lib/server/apps";
import { publish, q } from "@/lib/server/queue";
import { body, route } from "@/lib/server/route";

/** live: the preview release whose commit goes live (it must have run in this app's preview) */
const liveDeploySchema = z.object({ fromReleaseId: z.string() }).strict();

/**
 * Manual deploy. `?env=preview` (default), Admin or Owner: a queued release of the given branch (its head when the
 * worker starts) or exact commit, else the app's branch. `?env=live`, Owner with a fresh step-up: `{ fromReleaseId }`
 * names a preview release that ran (deployed or superseded); its exact commit goes live, and only once the live
 * domain's DNS check is ok (the worker checks again before it publishes) and, with a release window, only inside it
 * (409 live_outside_window with the next opening; rollbacks are never held back). One release per environment at a time.
 * The click itself is the human decision.
 */
export const POST = route<{ id: string }>("ADMIN", async ({ session, req, params }) => {
  const { app: a, env } = await loadAppEnv(session.workspaceId, params.id, req);
  if (env.kind === "live") await requireLiveOwner(session);
  await assertDeploysAllowed(session.workspaceId);
  await assertNotRemoving(a.id);
  if (!a.repositoryId) throw new HttpError(409, "The app's repository was removed", { code: "app_no_repository" });

  let values: Omit<typeof appReleases.$inferInsert, "appId" | "workspaceId" | "environmentId" | "status" | "createdBy">;
  let promotedFrom: string | null = null;
  if (env.kind === "live") {
    const { fromReleaseId } = await body(req, liveDeploySchema);
    const preview = await loadEnv(session.workspaceId, a.id, "preview");
    const [src] = isUuid(fromReleaseId)
      ? await db
          .select()
          .from(appReleases)
          .where(and(eq(appReleases.id, fromReleaseId), eq(appReleases.environmentId, preview.id), eq(appReleases.workspaceId, session.workspaceId)))
      : [];
    if (!src) throw new HttpError(404, "Release not found", { code: "release_not_found" });
    if (!(ROLLBACK_SOURCE_STATUSES as readonly string[]).includes(src.status) || !src.commit) {
      throw new HttpError(409, "Only a commit that ran in the preview can go live", { code: "live_needs_preview_release" });
    }
    if (env.dnsCheck?.status !== "ok") throw new HttpError(409, "The domain does not point at the server yet", { code: "live_dns_not_ok" });
    // a release window: releases start only inside it (rollbacks always pass; the worker checks again in prepare)
    const w = env.releaseWindow;
    if (w && !isWithinReleaseWindow(w)) {
      const opensAt = nextReleaseWindowOpening(w)?.toISOString() ?? "";
      throw new HttpError(409, "Outside the release window", { code: "live_outside_window", start: w.start, end: w.end, timeZone: w.timeZone, days: w.days, opensAt });
    }
    promotedFrom = src.id;
    values = { commit: src.commit, branch: src.branch, commitSubject: src.commitSubject, manifest: src.manifest, trigger: "manual", promotedFromReleaseId: src.id };
  } else {
    const input = await body(req, appDeploySchema);
    values = { commit: input.commit ?? "", branch: input.branch ?? a.branch, trigger: "manual" };
  }
  await assertServerReady(env.serverId);

  const release = await db.transaction(async (tx) => {
    // the environment row is the lock: two clicks at once cannot both see "nothing running"
    await tx.select({ id: appEnvironments.id }).from(appEnvironments).where(eq(appEnvironments.id, env.id)).for("update");
    if (await activeRelease(env.id, tx)) throw new HttpError(409, "A deploy of this app is already running", { code: "app_deploy_running" });
    // a database restore of this environment waits or runs: the release waits for it
    await assertNoRestore(env.id);
    if (promotedFrom) {
      // still a release that ran in the preview (an app removal could race this)
      const [still] = await tx
        .select({ id: appReleases.id })
        .from(appReleases)
        .where(and(eq(appReleases.id, promotedFrom), inArray(appReleases.status, [...ROLLBACK_SOURCE_STATUSES])));
      if (!still) throw new HttpError(409, "Only a commit that ran in the preview can go live", { code: "live_needs_preview_release" });
    }
    const [r] = await tx
      .insert(appReleases)
      .values({ ...values, appId: a.id, workspaceId: session.workspaceId, environmentId: env.id, status: "queued", createdBy: session.userId })
      .returning();
    return r!;
  });
  await q.deploy({ kind: "release", releaseId: release.id, workspaceId: session.workspaceId });
  await audit({
    workspaceId: session.workspaceId,
    actorUserId: session.userId,
    actorLabel: session.email,
    action: env.kind === "live" ? "app.live_deploy_requested" : "app.deploy_requested",
    targetType: "app",
    targetId: a.id,
    details: {
      name: a.name,
      environment: env.kind,
      environmentId: env.id,
      releaseId: release.id,
      branch: release.branch,
      commit: release.commit || null,
      ...(promotedFrom && { promotedFromReleaseId: promotedFrom, domain: env.domain }),
    },
  });
  await publish(session.workspaceId, { type: "release.updated", releaseId: release.id, appId: a.id, status: release.status, step: null });
  return { release: releaseDTO(release, session.name, env.kind) };
});
