import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { appEnvironments, apps, credentials, db, repositories, servers, workspaces } from "@wfos/db";
import { reencryptAll } from "@wfos/db/rotate";
import { decryptSecret, encryptSecret } from "@wfos/shared/server";
import { makeWorkspace } from "./fixtures";

const original = process.env.ENCRYPTION_KEY!;
afterEach(() => {
  process.env.ENCRYPTION_KEY = original;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

describe("ENCRYPTION_KEY rotation", () => {
  it("the previous key still decrypts; rotate-key moves every secret to the new key", async () => {
    const ws = await makeWorkspace(); // SMTP credential encrypted with the original key
    await db.update(workspaces).set({ webhookUrlEnc: encryptSecret("https://hooks.example/abc") }).where(eq(workspaces.id, ws.id));
    const [repo] = await db.insert(repositories).values({ workspaceId: ws.id, name: "r", provider: "github", url: "https://github.com/o/r.git", defaultBranch: "main", tokenEnc: encryptSecret("ghp_token") }).returning();

    const [srv] = await db.insert(servers).values({ workspaceId: ws.id, name: "dev", host: "s.example.com", baseDomain: "preview.example.com" }).returning();
    const [app] = await db
      .insert(apps)
      .values({
        workspaceId: ws.id,
        serverId: srv!.id,
        name: "Kopi",
        slug: `kopi-${ws.slug}`.slice(0, 30),
        domain: `${ws.slug}.preview.example.com`,
        port: 4100,
        accessPasswordEnc: encryptSecret("preview-pw"),
        envEnc: encryptSecret('{"SMTP_PASSWORD":"x"}'),
        appSecretEnc: encryptSecret("app-secret"),
        dbPasswordEnc: encryptSecret("db-pw"),
      })
      .returning();
    const [env] = await db
      .insert(appEnvironments)
      .values({
        appId: app!.id,
        workspaceId: ws.id,
        kind: "live",
        serverId: srv!.id,
        instanceName: `${app!.slug}-live`.slice(0, 35),
        domain: `${ws.slug}.kopi.example`,
        port: 4101,
        accessPasswordEnc: encryptSecret("live-pw"),
        envEnc: encryptSecret('{"PAYMENT_KEY":"live"}'),
        appSecretEnc: encryptSecret("live-secret"),
        dbPasswordEnc: encryptSecret("live-db-pw"),
      })
      .returning();

    const newKey = randomBytes(32).toString("hex");
    process.env.ENCRYPTION_KEY_PREVIOUS = original;
    process.env.ENCRYPTION_KEY = newKey;
    const [cred] = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id));
    expect(decryptSecret(cred!.secretEnc!)).toBe("smtp-pass"); // via the fallback

    const n = await reencryptAll({ workspaceIds: [ws.id] });
    expect(n["credentials.secret_enc"]).toBeGreaterThanOrEqual(1);
    expect(n["repositories.token_enc"]).toBeGreaterThanOrEqual(1);
    for (const col of ["accessPasswordEnc", "envEnc", "appSecretEnc", "dbPasswordEnc"]) expect(n[`apps.${col}`]).toBe(1);
    for (const col of ["accessPasswordEnc", "envEnc", "appSecretEnc", "dbPasswordEnc"]) expect(n[`app_environments.${col}`]).toBe(1);

    delete process.env.ENCRYPTION_KEY_PREVIOUS; // old key gone: everything must open with the new key alone
    const [c2] = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id));
    const [r2] = await db.select().from(repositories).where(eq(repositories.id, repo!.id));
    const [w2] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(decryptSecret(c2!.secretEnc!)).toBe("smtp-pass");
    expect(decryptSecret(r2!.tokenEnc!)).toBe("ghp_token");
    expect(decryptSecret(w2!.webhookUrlEnc!)).toBe("https://hooks.example/abc");
    const [a2] = await db.select().from(apps).where(eq(apps.id, app!.id));
    expect([a2!.accessPasswordEnc, a2!.envEnc, a2!.appSecretEnc, a2!.dbPasswordEnc].map((v) => decryptSecret(v!))).toEqual(["preview-pw", '{"SMTP_PASSWORD":"x"}', "app-secret", "db-pw"]);
    const [e2] = await db.select().from(appEnvironments).where(eq(appEnvironments.id, env!.id));
    expect([e2!.accessPasswordEnc, e2!.envEnc, e2!.appSecretEnc, e2!.dbPasswordEnc].map((v) => decryptSecret(v!))).toEqual(["live-pw", '{"PAYMENT_KEY":"live"}', "live-secret", "live-db-pw"]);
  });

  it("a wrong key fails loudly and rotation changes nothing", async () => {
    const ws = await makeWorkspace();
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex"); // no previous key: old values unreadable
    await expect(reencryptAll({ workspaceIds: [ws.id] })).rejects.toThrow();
    process.env.ENCRYPTION_KEY = original;
    const [c] = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id));
    expect(decryptSecret(c!.secretEnc!)).toBe("smtp-pass");
  });
});
