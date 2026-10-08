import { eq, isNotNull } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { getDb } from "./index";
import { credentials, repositories, users, workspaces } from "./schema";

/**
 * Re-encrypt every stored secret with the current ENCRYPTION_KEY. Values still under ENCRYPTION_KEY_PREVIOUS are
 * readable through decryptSecret's fallback. One transaction: either everything moves to the new key or nothing.
 */
export async function reencryptAll(): Promise<Record<string, number>> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const n: Record<string, number> = { "credentials.secret_enc": 0, "repositories.token_enc": 0, "workspaces.webhook_url_enc": 0, "users.totp_secret_enc": 0, "users.totp_pending_enc": 0 };
    for (const r of await tx.select({ id: credentials.id, v: credentials.secretEnc }).from(credentials).where(isNotNull(credentials.secretEnc))) {
      await tx.update(credentials).set({ secretEnc: encryptSecret(decryptSecret(r.v!)) }).where(eq(credentials.id, r.id));
      n["credentials.secret_enc"]!++;
    }
    for (const r of await tx.select({ id: repositories.id, v: repositories.tokenEnc }).from(repositories).where(isNotNull(repositories.tokenEnc))) {
      await tx.update(repositories).set({ tokenEnc: encryptSecret(decryptSecret(r.v!)) }).where(eq(repositories.id, r.id));
      n["repositories.token_enc"]!++;
    }
    for (const r of await tx.select({ id: workspaces.id, v: workspaces.webhookUrlEnc }).from(workspaces).where(isNotNull(workspaces.webhookUrlEnc))) {
      await tx.update(workspaces).set({ webhookUrlEnc: encryptSecret(decryptSecret(r.v!)) }).where(eq(workspaces.id, r.id));
      n["workspaces.webhook_url_enc"]!++;
    }
    for (const r of await tx.select({ id: users.id, a: users.totpSecretEnc, b: users.totpPendingEnc }).from(users)) {
      if (!r.a && !r.b) continue;
      await tx
        .update(users)
        .set({ totpSecretEnc: r.a ? encryptSecret(decryptSecret(r.a)) : null, totpPendingEnc: r.b ? encryptSecret(decryptSecret(r.b)) : null })
        .where(eq(users.id, r.id));
      if (r.a) n["users.totp_secret_enc"]!++;
      if (r.b) n["users.totp_pending_enc"]!++;
    }
    return n;
  });
}
