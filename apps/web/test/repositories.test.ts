import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, members, repositories, servers, users, workspaces } from "@wfos/db";
import { decryptSecret } from "@wfos/shared/server";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listRepos, POST as addRepo } from "@/app/api/repositories/route";
import { DELETE as removeRepo, PATCH as patchRepo } from "@/app/api/repositories/[id]/route";
import { call, callWithParams, jar, resetBrowser } from "./browser";

const PASSWORD = "pw-123456-repos";
const TOKEN = "github_pat_11AAAAAAA0secret";

beforeEach(() => resetBrowser());

async function signIn(role: "OWNER" | "ADMIN", wsId?: string) {
  const id = wsId ?? (await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning())[0]!.id;
  const email = `r-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: `${role} person`, passwordHash: await bcrypt.hash(PASSWORD, 4) }).returning();
  await db.insert(members).values({ workspaceId: id, userId: u!.id, role });
  jar.clear();
  expect((await call(login, "POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(200);
  return { wsId: id };
}

type Repo = { id: string; url: string; tokenSet: boolean };
const repoOf = (r: { json: Record<string, unknown> }) => r.json.repository as Repo;
const add = (body: Record<string, unknown>) => call(addRepo, "POST", "/api/repositories", { name: `repo-${randomUUID().slice(0, 6)}`, provider: "github", defaultBranch: "main", ...body });

describe("repositories: clone URLs", () => {
  it("connects a GitHub clone URL; a website address or a repository-less URL is refused", async () => {
    await signIn("OWNER");
    const ok = await add({ url: "https://github.com/acme/shop.git", token: TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.json.repository).toMatchObject({ url: "https://github.com/acme/shop.git", tokenSet: true, tokenLast4: "cret" });
    for (const url of ["https://acme.example.com", "https://github.com/acme", "https://github.com/acme/shop/tree/main", "https://gitlab.com/acme/shop.git", "https://github.com/acme/shop.git?ref=x"]) {
      const r = await add({ url });
      expect(r.status, url).toBe(400);
      expect(r.json.code, url).toBe("repository_url_invalid");
    }
    expect((await add({ provider: "gitlab", url: "https://gitlab.example.com/team/shop.git" })).status).toBe(200);
    expect((await add({ provider: "git", url: "https://git.example.com/shop.git" })).status).toBe(200);
    expect((await add({ provider: "git", url: "https://git.example.com/" })).json.code).toBe("repository_url_invalid");
  });

  it("refuses an address served by one of the workspace's app servers (an app preview)", async () => {
    const o = await signIn("OWNER");
    await db.insert(servers).values({ workspaceId: o.wsId, name: "Preview", host: "45.77.10.20", baseDomain: "preview.acme.example" });
    const r = await add({ provider: "git", url: "https://shop.preview.acme.example/app.git" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("repository_url_is_preview");
  });
});

describe("repositories: edit", () => {
  it("the Owner changes the URL, branch and token in place; the token is never shown, only audited by its last 4", async () => {
    const o = await signIn("OWNER");
    const id = repoOf(await add({ url: "https://github.com/acme/shop.git" })).id;
    const r = await callWithParams(patchRepo, "PATCH", "/x", { url: "https://github.com/acme/shop-v2.git", defaultBranch: "develop", token: TOKEN }, { id });
    expect(r.status).toBe(200);
    expect(r.json.repository).toMatchObject({ url: "https://github.com/acme/shop-v2.git", defaultBranch: "develop", tokenSet: true, tokenLast4: "cret" });
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
    const [row] = await db.select().from(repositories).where(eq(repositories.id, id));
    expect(decryptSecret(row!.tokenEnc!)).toBe(TOKEN);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "repository.updated")));
    expect(a!.details).toMatchObject({ url: { from: "https://github.com/acme/shop.git", to: "https://github.com/acme/shop-v2.git" }, defaultBranch: { from: "main", to: "develop" }, token: "…cret" });
    expect(JSON.stringify(a!.details)).not.toContain(TOKEN);

    // null removes the token; a bad URL is refused like on connect
    expect(repoOf(await callWithParams(patchRepo, "PATCH", "/x", { token: null }, { id })).tokenSet).toBe(false);
    expect((await callWithParams(patchRepo, "PATCH", "/x", { url: "https://shop.example.com" }, { id })).status).toBe(400);
    expect(((await call(listRepos, "GET", "/api/repositories")).json.repositories as Repo[]).find((x) => x.id === id)?.url).toBe("https://github.com/acme/shop-v2.git");
    expect(o.wsId).toBeTruthy();
  });

  it("only the Owner edits or removes, and only repositories of its own workspace", async () => {
    await signIn("OWNER");
    const id = repoOf(await add({ url: "https://github.com/acme/shop.git" })).id;
    await signIn("OWNER");
    expect((await callWithParams(patchRepo, "PATCH", "/x", { defaultBranch: "x" }, { id })).status).toBe(404);
    expect((await callWithParams(removeRepo, "DELETE", "/x", undefined, { id })).status).toBe(404);
    const [{ workspaceId }] = (await db.select({ workspaceId: repositories.workspaceId }).from(repositories).where(eq(repositories.id, id))) as [{ workspaceId: string }];
    await signIn("ADMIN", workspaceId);
    expect((await callWithParams(patchRepo, "PATCH", "/x", { defaultBranch: "x" }, { id })).status).toBe(403);
  });
});
