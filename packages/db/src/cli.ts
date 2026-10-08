import { config } from "dotenv";
import { assertNotProductionTarget } from "@wfos/shared/runtime";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb, getSql } from "./index";
import { audit } from "./audit";
import { members, users } from "./schema";
import { reencryptAll } from "./rotate";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env"), quiet: true });
assertNotProductionTarget();

const USAGE = `Workforce OS owner CLI (run on the server; it uses DATABASE_URL from .env)

  pnpm --filter @wfos/db cli unlock <email>      clear a login lockout
  pnpm --filter @wfos/db cli reset-2fa <email>   turn off 2FA, delete recovery codes and clear the lockout
                                                 (the user must set up 2FA again if a workspace requires it)
  pnpm --filter @wfos/db cli rotate-key          re-encrypt all stored secrets with ENCRYPTION_KEY
                                                 (set the old key as ENCRYPTION_KEY_PREVIOUS first; see docs/DEPLOY.md)
`;

async function main() {
  const [cmd, emailArg] = process.argv.slice(2);
  if (cmd === "rotate-key") {
    if (!process.env.ENCRYPTION_KEY_PREVIOUS) console.warn("ENCRYPTION_KEY_PREVIOUS is not set: only values already under ENCRYPTION_KEY can be read.");
    const n = await reencryptAll();
    for (const [col, count] of Object.entries(n)) console.log(`${col}: ${count}`);
    console.log("Done. Restart wfos-web and wfos-worker, then remove ENCRYPTION_KEY_PREVIOUS from .env.");
    return;
  }
  if (!cmd || !emailArg || !["unlock", "reset-2fa"].includes(cmd)) {
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  const db = getDb();
  const email = emailArg.toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exitCode = 1;
    return;
  }
  const set: Partial<typeof users.$inferInsert> = { failedLoginCount: 0, lockedUntil: null };
  if (cmd === "reset-2fa") Object.assign(set, { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastCounter: null, recoveryCodes: [] });
  await db.update(users).set(set).where(eq(users.id, user.id));
  const action = cmd === "reset-2fa" ? "user.2fa_reset_by_cli" : "user.unlocked_by_cli";
  const ms = await db.select({ workspaceId: members.workspaceId }).from(members).where(eq(members.userId, user.id));
  for (const m of ms) await audit({ workspaceId: m.workspaceId, actorLabel: `cli:${process.env.USER ?? "unknown"}`, action, targetType: "user", targetId: user.id, details: { email } });
  console.log(cmd === "reset-2fa" ? `2FA reset and lockout cleared for ${email}.` : `Lockout cleared for ${email}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
