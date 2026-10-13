import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { generateWorkspaceKey } from "@wfos/shared/ssh-keys";
import type { DB } from "./index";
import { credentials } from "./schema";

const KIND = "ssh";
const NAME = "default";

/** What may be shown about the workspace SSH key (never the private half). */
export interface WorkspaceSshKey {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

function publicPart(config: Record<string, unknown>): WorkspaceSshKey | null {
  const { publicKey, fingerprint, createdAt } = config as Partial<WorkspaceSshKey>;
  return typeof publicKey === "string" && typeof fingerprint === "string" ? { publicKey, fingerprint, createdAt: String(createdAt ?? "") } : null;
}

async function keyRow(db: DB, workspaceId: string) {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.workspaceId, workspaceId), eq(credentials.kind, KIND), eq(credentials.name, NAME)));
  return row;
}

/**
 * The workspace's SSH key (one ed25519 pair per workspace, comment `wfos-<slug>`), created on first use. Safe under
 * concurrency: the insert does nothing when another request created the key first, and the stored row is re-read,
 * so every caller gets the same key. Only the public half is returned; see workspaceSshPrivateKey.
 */
export async function getOrCreateWorkspaceSshKey(db: DB, workspaceId: string, slug: string): Promise<WorkspaceSshKey> {
  const existing = await keyRow(db, workspaceId);
  const known = existing && publicPart(existing.config);
  if (known && existing.secretEnc) return known;
  const k = generateWorkspaceKey(`wfos-${slug}`);
  const config: WorkspaceSshKey = { publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: new Date().toISOString() };
  await db
    .insert(credentials)
    .values({ workspaceId, kind: KIND, name: NAME, config: { ...config }, secretEnc: encryptSecret(k.privateKey) })
    .onConflictDoNothing({ target: [credentials.workspaceId, credentials.kind, credentials.name] });
  const row = await keyRow(db, workspaceId);
  const stored = row && publicPart(row.config);
  if (!stored || !row.secretEnc) throw new Error("The workspace SSH key could not be created");
  return stored;
}

/** The decrypted private key (server side only: for the SSH client, never logged or sent anywhere), or null. */
export async function workspaceSshPrivateKey(db: DB, workspaceId: string): Promise<string | null> {
  const row = await keyRow(db, workspaceId);
  return row?.secretEnc ? decryptSecret(row.secretEnc) : null;
}
