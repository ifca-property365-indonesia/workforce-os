import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, db, shareLinks } from "@wfos/db";
import { route, body } from "@/lib/server/route";
import { requireStepUp } from "@/lib/server/twofactor";
import { serverEnv } from "@/lib/server/env";
import { hashShareToken, newShareToken, SHARE_HOURS } from "@/lib/server/share";

/** The workspace's view-only links (Owner), newest first. Tokens are never shown again after creation. */
export const GET = route("OWNER", async ({ session }) => {
  const rows = await db
    .select({ id: shareLinks.id, label: shareLinks.label, createdAt: shareLinks.createdAt, expiresAt: shareLinks.expiresAt, revokedAt: shareLinks.revokedAt, lastUsedAt: shareLinks.lastUsedAt, opens: shareLinks.opens })
    .from(shareLinks)
    .where(eq(shareLinks.workspaceId, session.workspaceId))
    .orderBy(desc(shareLinks.createdAt))
    .limit(50);
  return { links: rows };
});

const schema = z.object({
  label: z.string().trim().min(1).max(80),
  hours: z.number().refine((h) => (SHARE_HOURS as readonly number[]).includes(h), { message: "hours: 2, 24, 72 or 168" }),
});

/**
 * A view-only link (after AIRIS 1f1b126): whoever opens it reads the workspace without an account until it expires.
 * The Owner's decision, with a fresh step-up; the URL (with its token) is returned once.
 */
export const POST = route("OWNER", async ({ session, req }) => {
  const b = await body(req, schema);
  await requireStepUp(session);
  const token = newShareToken();
  const expiresAt = new Date(Date.now() + b.hours * 3_600_000);
  const [row] = await db.insert(shareLinks).values({ workspaceId: session.workspaceId, tokenHash: hashShareToken(token), label: b.label, createdBy: session.userId, expiresAt }).returning({ id: shareLinks.id });
  await audit({ workspaceId: session.workspaceId, actorUserId: session.userId, actorLabel: session.email, action: "share_link.created", targetType: "share_link", targetId: row!.id, details: { label: b.label, hours: b.hours } });
  return { id: row!.id, url: `${serverEnv.appUrl.replace(/\/+$/, "")}/lihat/${token}`, expiresAt };
});

