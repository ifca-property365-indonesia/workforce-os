import { and, eq } from "drizzle-orm";
import { appEnvironments, appTestUsers, db } from "@wfos/db";
import { parseTestUsersOutput, type TestUsersOutput } from "@wfos/shared";
import { encryptSecret } from "@wfos/shared/server";

/**
 * C10: the test accounts of a preview, from the app's own testUsers command (wfos-app.json). The command runs after
 * the migration of each preview release (helper v5 `build-run … test-users`), reads the shared password from
 * $WFOS_TEST_PASSWORD and prints the accounts per role as one JSON line. That output carries TOTP keys: it is parsed
 * here and never written to the release log.
 */

/** helper version that runs the test-users step (older helpers keep deploying; the step is skipped) */
export const TEST_USERS_HELPER_VERSION = 5;
export const TEST_USERS_TIMEOUT_SEC = 180;

/**
 * Replace the environment's auto accounts with the script's, in one transaction. A manual account keeps its role
 * (a person's choice wins over the script). Returns the roles stored and the ones a manual row kept.
 */
export async function storeTestUsers(env: { id: string; workspaceId: string }, out: TestUsersOutput): Promise<{ stored: string[]; keptManual: string[] }> {
  return db.transaction(async (tx) => {
    const manual = new Set(
      (await tx.select({ role: appTestUsers.role }).from(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.source, "manual")))).map((r) => r.role),
    );
    await tx.delete(appTestUsers).where(and(eq(appTestUsers.environmentId, env.id), eq(appTestUsers.source, "auto")));
    const rows = out.users.filter((u) => !manual.has(u.role));
    if (rows.length) {
      await tx.insert(appTestUsers).values(
        rows.map((u) => ({
          environmentId: env.id,
          workspaceId: env.workspaceId,
          role: u.role,
          label: u.label,
          username: u.username,
          totpEnc: u.totp ? encryptSecret(u.totp) : null,
          loginPath: u.loginPath,
          source: "auto" as const,
          viewAll: u.viewAll,
          note: u.note,
        })),
      );
    }
    const stored = rows.map((u) => u.role);
    const keptManual = out.users.filter((u) => manual.has(u.role)).map((u) => u.role);
    const note = [out.note ?? "", keptManual.length ? `kept manual: ${keptManual.join(", ")}` : ""].filter(Boolean).join(" · ");
    await tx.update(appEnvironments).set({ testUsersAt: new Date(), testUsersNote: note || null }).where(eq(appEnvironments.id, env.id));
    return { stored, keptManual };
  });
}

/** The script failed or printed nothing usable: the accounts stay as they were, the reason is shown on the app. */
export async function recordTestUsersFailure(envId: string, why: string): Promise<void> {
  await db.update(appEnvironments).set({ testUsersAt: new Date(), testUsersNote: `failed: ${why}`.slice(0, 500) }).where(eq(appEnvironments.id, envId));
}

/** Parse + store; a summary line for the release log (roles only, never usernames' secrets or keys). */
export async function applyTestUsersOutput(env: { id: string; workspaceId: string }, output: string): Promise<string> {
  const parsed = parseTestUsersOutput(output);
  if (!parsed.ok) {
    await recordTestUsersFailure(env.id, parsed.error);
    return `test accounts: not updated (${parsed.error})`;
  }
  const r = await storeTestUsers(env, parsed.value);
  return `test accounts: ${r.stored.length} role(s) (${r.stored.join(", ") || "none"})${r.keptManual.length ? `; kept the manual ${r.keptManual.join(", ")}` : ""}`;
}
