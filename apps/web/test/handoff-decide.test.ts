import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { approvals, db, employees, members, users, workspaces } from "@wfos/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { callWithParams, call, resetBrowser } from "./browser";

beforeEach(() => resetBrowser());

describe("PRD handoff decision", () => {
  it("Edit & Approve can change the developer and repository but never the PRD text", async () => {
    const email = `d-${randomUUID().slice(0, 8)}@test.local`;
    const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role: "ADMIN" });
    const [dev] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Dev", role: "Developer", model: "m" }).returning();
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: ws!.id, toolName: "handoff_prd", title: "PRD: x", payload: { title: "x", prd: "approved text", developerId: null, repositoryId: null } })
      .returning();
    await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
    const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "edit_approve", editedPayload: { developerId: dev!.id, repositoryId: null, prd: "TAMPERED" } }, { id: a!.id });
    expect(r.status).toBe(200);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, a!.id));
    expect(after!.editedPayload).toMatchObject({ prd: "approved text", developerId: dev!.id });
  });
});
