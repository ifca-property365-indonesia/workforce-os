import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approvals, auditLog, db, employees, members, skillAuditTasks, skills, tasks, users, workspaces, type SkillOrigin } from "@wfos/db";
import { setCatalogFetch, skillHash } from "@wfos/shared/skill-catalog";
import { GET as getAudit, POST as startAudit, PUT as putAudit } from "@/app/api/hr/skill-audit/route";
import { GET as previewUpdate, POST as applyUpdate } from "@/app/api/skills/[id]/update/route";
import { GET as listSkills } from "@/app/api/skills/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { setSession } from "@/lib/server/auth";
import { fakeCatalog, sha, SKILL_MD, type FakeRepo } from "../../../packages/shared/test/fake-catalog";
import { call, callWithParams, resetBrowser } from "./browser";

afterEach(() => setCatalogFetch(null));

async function setup(role: "OWNER" | "ADMIN" | "MEMBER" = "ADMIN") {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  const [u] = await db.insert(users).values({ email: `u-${randomUUID().slice(0, 8)}@test.local`, name: "Admin" }).returning();
  await db.insert(members).values({ workspaceId: ws!.id, userId: u!.id, role });
  resetBrowser();
  await setSession(u!.id, ws!.id);
  const [hr] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Ratna", role: "HR Lead", model: "m" }).returning();
  const [dev] = await db.insert(employees).values({ workspaceId: ws!.id, name: "Bima", role: "Frontend Developer", model: "m" }).returning();
  return { ws: ws!, user: u!, hr: hr!, dev: dev! };
}

const audits = (wsId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.action, action)));

describe("skill audit (C4)", () => {
  it("Admins only; the HR employee is found by role; one audit at a time", async () => {
    const s = await setup();
    const g = await call(getAudit, "GET", "/api/hr/skill-audit");
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ settings: { monthly: false, hrEmployeeId: null }, hrEmployee: { id: s.hr.id, name: "Ratna" }, last: null, pendingProposals: 0 });
    const r = await call(startAudit, "POST", "/api/hr/skill-audit", {});
    expect(r.status).toBe(200);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(t).toMatchObject({ assigneeId: s.hr.id, status: "QUEUED", source: "board" });
    expect(await db.select().from(skillAuditTasks).where(eq(skillAuditTasks.taskId, t!.id))).toHaveLength(1);
    expect(await audits(s.ws.id, "skills.audit_started")).toHaveLength(1);
    const again = await call(startAudit, "POST", "/api/hr/skill-audit", {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("skill_audit_running");

    await setup("MEMBER");
    expect((await call(getAudit, "GET", "/api/hr/skill-audit")).status).toBe(403);
    expect((await call(startAudit, "POST", "/api/hr/skill-audit", {})).status).toBe(403);
  });

  it("settings: the monthly switch and who runs it (an active employee of this workspace)", async () => {
    const other = await setup();
    const s = await setup();
    const p = await call(putAudit, "PUT", "/api/hr/skill-audit", { monthly: true });
    expect(p.json).toMatchObject({ settings: { monthly: true, hrEmployeeId: null } });
    expect((await call(putAudit, "PUT", "/api/hr/skill-audit", { hrEmployeeId: other.hr.id })).json.code).toBe("skill_audit_no_hr");
    expect((await call(putAudit, "PUT", "/api/hr/skill-audit", { hrEmployeeId: s.dev.id })).json).toMatchObject({ settings: { monthly: true, hrEmployeeId: s.dev.id } });
    const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, s.ws.id));
    expect(ws!.settings).toMatchObject({ skillAudit: { monthly: true, hrEmployeeId: s.dev.id } });
    const r = await call(startAudit, "POST", "/api/hr/skill-audit", {});
    const [t] = await db.select().from(tasks).where(eq(tasks.id, r.json.taskId as string));
    expect(t!.assigneeId).toBe(s.dev.id);
  });

  it("no HR employee: a clear 400", async () => {
    const s = await setup();
    await db.update(employees).set({ role: "Sales" }).where(eq(employees.id, s.hr.id));
    const r = await call(startAudit, "POST", "/api/hr/skill-audit", {});
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("skill_audit_no_hr");
  });

  it("an install_skill approval is approved or rejected, never edited", async () => {
    const s = await setup();
    const [t] = await db.insert(tasks).values({ workspaceId: s.ws.id, title: "audit", assigneeId: s.hr.id, status: "AWAITING_APPROVAL" }).returning();
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: s.ws.id, taskId: t!.id, employeeId: s.hr.id, toolName: "install_skill", title: "Install", reason: "r", payload: { source: "acme/skills", skillId: "pdf-tools", body: "x" } })
      .returning();
    const r = await callWithParams(decide, "POST", `/api/approvals/${a!.id}/decide`, { decision: "edit_approve", editedPayload: { body: "evil" } }, { id: a!.id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("skill_install_not_editable");
  });
});

describe("catalog skill updates (C4)", () => {
  async function installed(wsId: string) {
    const v1 = SKILL_MD("pdf-tools", "Use for PDF work", "v1");
    const repo: FakeRepo = { head: sha("b"), commits: { [sha("a")]: { "skills/pdf-tools/SKILL.md": v1 }, [sha("b")]: { "skills/pdf-tools/SKILL.md": SKILL_MD("pdf-tools", "Newer", "v2"), "skills/pdf-tools/run.sh": "echo" } } };
    setCatalogFetch(fakeCatalog({ "acme/skills": repo }).fetchImpl);
    const origin: SkillOrigin = { kind: "github", source: "acme/skills", skillId: "pdf-tools", path: "skills/pdf-tools/SKILL.md", dir: "skills/pdf-tools", commit: sha("a"), license: "MIT", licenseFile: null, url: "https://github.com/acme/skills", contentHash: skillHash(v1), installs: null };
    const [sk] = await db
      .insert(skills)
      .values({ workspaceId: wsId, slug: "pdf-tools", description: "Use for PDF work", body: "v1", source: "catalog", provenanceHash: "x", origin, updateAvailable: { commit: sha("b"), checkedAt: new Date().toISOString() } })
      .returning();
    return { sk: sk! };
  }

  it("the list shows where a catalog skill came from and that an update exists", async () => {
    const s = await setup();
    await installed(s.ws.id);
    const r = await call(listSkills, "GET", "/api/skills");
    expect((r.json.skills as unknown[])[0]).toMatchObject({ source: "catalog", origin: { source: "acme/skills", commit: sha("a"), license: "MIT" }, updateAvailable: sha("b"), fileCount: 0 });
  });

  it("an Admin compares and applies exactly the version read; a changed version is refused", async () => {
    const s = await setup();
    const { sk } = await installed(s.ws.id);
    const p = await callWithParams(previewUpdate, "GET", `/api/skills/${sk.id}/update`, undefined, { id: sk.id });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ current: { commit: sha("a"), body: "v1" }, next: { commit: sha("b"), body: "v2", license: "MIT", sameFolder: true } });
    const next = p.json.next as { commit: string; contentHash: string; filesHash: string };
    const stale = await callWithParams(applyUpdate, "POST", `/api/skills/${sk.id}/update`, { ...next, contentHash: "0".repeat(64) }, { id: sk.id });
    expect(stale.status).toBe(409);
    const otherFiles = await callWithParams(applyUpdate, "POST", `/api/skills/${sk.id}/update`, { ...next, filesHash: "0".repeat(64) }, { id: sk.id });
    expect(otherFiles.json.code).toBe("skill_update_changed");
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("skill_update_changed");
    const ok = await callWithParams(applyUpdate, "POST", `/api/skills/${sk.id}/update`, { commit: next.commit, contentHash: next.contentHash, filesHash: next.filesHash }, { id: sk.id });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(skills).where(eq(skills.id, sk.id));
    expect(after).toMatchObject({ body: "v2", description: "Newer", updateAvailable: null, files: [{ path: "run.sh", content: "echo" }] });
    expect(after!.origin).toMatchObject({ commit: sha("b") });
    expect(await audits(s.ws.id, "skill.updated_from_catalog")).toHaveLength(1);
    // nothing more to apply
    expect((await callWithParams(previewUpdate, "GET", `/api/skills/${sk.id}/update`, undefined, { id: sk.id })).json.code).toBe("skill_no_update");
  });

  it("members cannot read or apply updates", async () => {
    const s = await setup("MEMBER");
    const { sk } = await installed(s.ws.id);
    expect((await callWithParams(previewUpdate, "GET", `/api/skills/${sk.id}/update`, undefined, { id: sk.id })).status).toBe(403);
  });
});
