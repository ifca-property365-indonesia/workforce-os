import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, db, employees, employeeSkills, members, skills, users, workspaces } from "@wfos/db";
import { SKILL_BODY_MAX, SKILL_DESCRIPTION_MAX } from "@wfos/shared";
import { GET as list, POST as create } from "@/app/api/skills/route";
import { DELETE as remove, GET as getOne, PATCH as patch } from "@/app/api/skills/[id]/route";
import { GET as listAssigned, PUT as assign } from "@/app/api/employees/[id]/skills/route";
import { setSession } from "@/lib/server/auth";
import { skillProvenanceHash } from "@/lib/server/skills";
import { flowScalar, parseSkillMarkdown, SKILL_FRONTMATTER_MAX, toSkillMarkdown } from "@/lib/skill-md";
import { call, callWithParams, resetBrowser } from "./browser";

const ANT_KEY = "sk-ant-api03-" + "Q7".repeat(24);

async function workspace() {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false }).returning();
  return ws!;
}

async function signIn(wsId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" = "ADMIN") {
  const [u] = await db.insert(users).values({ email: `u-${randomUUID().slice(0, 8)}@test.local`, name: "Admin" }).returning();
  await db.insert(members).values({ workspaceId: wsId, userId: u!.id, role });
  resetBrowser();
  await setSession(u!.id, wsId);
  return u!;
}

async function employee(wsId: string, name = "Dewi") {
  const [e] = await db.insert(employees).values({ workspaceId: wsId, name, role: "Sales", model: "claude-sonnet-5-5" }).returning();
  return e!;
}

const post = (body: unknown) => call(create, "POST", "/api/skills", body);
const one = (id: string) => callWithParams(getOne, "GET", `/api/skills/${id}`, undefined, { id });
const edit = (id: string, body: unknown) => callWithParams(patch, "PATCH", `/api/skills/${id}`, body, { id });
const del = (id: string) => callWithParams(remove, "DELETE", `/api/skills/${id}`, undefined, { id });
const put = (employeeId: string, skillIds: string[]) => callWithParams(assign, "PUT", `/api/employees/${employeeId}/skills`, { skillIds }, { id: employeeId });
const assigned = (employeeId: string) => callWithParams(listAssigned, "GET", `/api/employees/${employeeId}/skills`, undefined, { id: employeeId });
const audits = async (wsId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.action, action)));

const SKILL_MD = `---
name: weekly-report
description: >
  How to write the weekly sales report:
  numbers first, then risks.
license: MIT
allowed-tools: Bash
---

# Weekly report

1. Pull the pipeline numbers.
2. List the risks.
`;

beforeEach(() => resetBrowser());

describe("SKILL.md frontmatter", () => {
  it("reads name and description (folded) and ignores every other field", () => {
    const r = parseSkillMarkdown(SKILL_MD);
    expect(r).toEqual({
      ok: true,
      name: "weekly-report",
      description: "How to write the weekly sales report: numbers first, then risks.",
      body: "# Weekly report\n\n1. Pull the pipeline numbers.\n2. List the risks.",
      ignoredFields: ["license", "allowed-tools"],
    });
  });

  it.each([
    ["plain", "description: Use it for refunds # a comment", "Use it for refunds"],
    ["double quoted with escapes", 'description: "Say \\"hi\\": then\\nstop"', 'Say "hi": then\nstop'],
    ["single quoted", "description: 'It''s for refunds: always'", "It's for refunds: always"],
    ["literal block", "description: |\n  Line one\n  Line two\n", "Line one\nLine two"],
    ["plain continued on the next line", "description: Use it for\n  refunds and returns", "Use it for refunds and returns"],
  ])("parses a %s description", (_label, line, want) => {
    const r = parseSkillMarkdown(`---\nname: refunds\n${line}\n---\nBody`);
    expect(r).toMatchObject({ ok: true, name: "refunds", description: want, body: "Body" });
  });

  it("handles CRLF, a BOM, nested metadata and a leading blank line", () => {
    const md = "﻿\r\n---\r\nname: crm-notes\r\nmetadata:\r\n  version: 2\r\n  author: x\r\ndescription: Notes\r\n---\r\n\r\nText\r\n";
    expect(parseSkillMarkdown(md)).toEqual({ ok: true, name: "crm-notes", description: "Notes", body: "Text", ignoredFields: ["metadata"] });
  });

  it.each([
    ["no frontmatter", "# Just markdown", "no_frontmatter"],
    ["an unclosed frontmatter", "---\nname: x\ndescription: y\n", "unclosed_frontmatter"],
    ["no name", "---\ndescription: y\n---\nb", "missing_name"],
    ["no description", "---\nname: x\n---\nb", "missing_description"],
    ["an unterminated quote", '---\nname: x\ndescription: "oops\n---\nb', "bad_yaml"],
    ["a line that is not a key", "---\nname: x\njust words\n---\nb", "bad_yaml"],
  ])("refuses %s", (_label, md, error) => {
    expect(parseSkillMarkdown(md)).toMatchObject({ ok: false, error });
  });

  it("round-trips through toSkillMarkdown", () => {
    const s = { slug: "tricky", description: 'Quotes " and: colons # and \\ slashes\tand tabs', body: "---\nnot frontmatter\n---" };
    expect(parseSkillMarkdown(toSkillMarkdown(s))).toMatchObject({ ok: true, name: s.slug, description: s.description, body: s.body });
  });
});

describe("skills API", () => {
  it("creates from fields and from a SKILL.md, stores source user and the provenance hash, audits", async () => {
    const ws = await workspace();
    const u = await signIn(ws.id);
    const a = await post({ slug: "refunds", description: "How to handle refunds", body: "Check the order first." });
    expect(a.status).toBe(200);
    const b = await post({ markdown: SKILL_MD });
    expect(b.status).toBe(200);
    expect(b.json.ignoredFields).toEqual(["license", "allowed-tools"]);
    const rows = await db.select().from(skills).where(eq(skills.workspaceId, ws.id)).orderBy(skills.slug);
    expect(rows.map((r) => r.slug)).toEqual(["refunds", "weekly-report"]);
    expect(rows[0]).toMatchObject({ source: "user", enabled: true, untrusted: false, createdBy: u.id, provenanceHash: skillProvenanceHash("refunds", "How to handle refunds", "Check the order first.") });
    expect(rows[0]!.provenanceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]!.body).toBe("# Weekly report\n\n1. Pull the pipeline numbers.\n2. List the risks.");
    expect(await audits(ws.id, "skill.created")).toHaveLength(2);
  });

  it("validates the slug, the description and the sizes", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const bad = async (body: unknown) => (await post(body)).json.code;
    expect(await bad({ slug: "Weekly Report", description: "d", body: "Steps." })).toBe("skill_invalid_slug");
    expect(await bad({ slug: "weekly--report", description: "d", body: "Steps." })).toBe("skill_invalid_slug");
    expect(await bad({ slug: "a".repeat(65), description: "d", body: "Steps." })).toBe("skill_invalid_slug");
    expect(await bad({ slug: "ok", description: "   ", body: "Steps." })).toBe("skill_description_required");
    expect(await bad({ slug: "ok", description: "d".repeat(SKILL_DESCRIPTION_MAX + 1), body: "Steps." })).toBe("skill_description_too_long");
    expect(await bad({ slug: "ok", description: "d", body: "b".repeat(SKILL_BODY_MAX + 1) })).toBe("skill_body_too_long");
    // the limit is in UTF-8 bytes, as the worker enforces it: fewer characters than the limit can still be too large
    const multibyte = await post({ slug: "ok", description: "d", body: "é".repeat(SKILL_BODY_MAX / 2 + 1) });
    expect(multibyte.json).toMatchObject({ code: "skill_body_too_long", max: SKILL_BODY_MAX, bytes: SKILL_BODY_MAX + 2 });
    expect(String(multibyte.json.error)).toMatch(/bytes/);
    expect((await post({ slug: "fits", description: "d", body: "é".repeat(SKILL_BODY_MAX / 2) })).status).toBe(200);
    expect(await bad({ markdown: "# no frontmatter" })).toBe("skill_md_invalid");
    expect(await bad({ markdown: "---\nname: Bad Name\ndescription: d\n---\n" })).toBe("skill_invalid_slug");
    // both shapes at once (or extra fields) are not accepted
    expect(await bad({ slug: "ok", description: "d", body: "", markdown: SKILL_MD })).toBe("validation");
    const r = await post({ markdown: "---\nname: x\n---\n" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/no description/);
    await post({ slug: "dupe", description: "d", body: "Steps." });
    const dupe = await post({ slug: "dupe", description: "d2", body: "Steps." });
    expect(dupe.status).toBe(409);
    expect(dupe.json.code).toBe("skill_slug_taken");
    expect((await db.select().from(skills).where(eq(skills.workspaceId, ws.id))).map((r) => r.slug).sort()).toEqual(["dupe", "fits"]);
  });

  it("refuses a skill carrying a secret and names the rules; medium findings are warnings", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const r = await post({ slug: "crm", description: "CRM access", body: `Use the key ${ANT_KEY} and password: hunter2222` });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("skill_leak");
    expect(r.json.ruleList).toEqual(expect.arrayContaining(["anthropic-key", "password-assignment"]));
    expect(String(r.json.error)).toContain("anthropic-key");
    expect(JSON.stringify(r.json)).not.toContain(ANT_KEY);
    const inDescription = await post({ slug: "crm", description: `Key ${ANT_KEY}`, body: "Steps." });
    expect(inDescription.json.code).toBe("skill_leak");
    expect(await db.select().from(skills).where(eq(skills.workspaceId, ws.id))).toHaveLength(0);
    const md = await post({ markdown: `---\nname: crm\ndescription: CRM\n---\nToken ${ANT_KEY}` });
    expect(md.json.code).toBe("skill_leak");
    const medium = await post({ slug: "kyc", description: "KYC", body: "Example NIK 3171234567890123" });
    expect(medium.status).toBe(200);
    expect(medium.json.warnings).toEqual(["nik-indonesia"]);
  });

  it("edits description and body (hash recomputed), switches on and off, keeps the untrusted mark, deletes", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const [imported] = await db
      .insert(skills)
      .values({ workspaceId: ws.id, slug: "imported", description: "d", body: "b", source: "import", untrusted: true, provenanceHash: skillProvenanceHash("imported", "d", "b") })
      .returning();
    const r = await edit(imported!.id, { description: "  New description ", body: "New body\n\n" });
    expect(r.status).toBe(200);
    let [row] = await db.select().from(skills).where(eq(skills.id, imported!.id));
    expect(row).toMatchObject({ description: "New description", body: "New body", untrusted: true, source: "import", provenanceHash: skillProvenanceHash("imported", "New description", "New body") });
    expect((await edit(imported!.id, { enabled: false })).status).toBe(200);
    [row] = await db.select().from(skills).where(eq(skills.id, imported!.id));
    expect(row!.enabled).toBe(false);
    expect((await edit(imported!.id, {})).json.code).toBe("nothing_to_change");
    expect((await edit(imported!.id, { body: `key ${ANT_KEY}` })).json.code).toBe("skill_leak");
    expect((await edit(imported!.id, { description: "" })).json.code).toBe("skill_description_required");
    // the slug and the trust mark are not editable
    await edit(imported!.id, { slug: "renamed", untrusted: false, description: "Same" });
    [row] = await db.select().from(skills).where(eq(skills.id, imported!.id));
    expect(row).toMatchObject({ slug: "imported", untrusted: true, description: "Same" });
    const [upd] = await audits(ws.id, "skill.updated");
    expect(upd!.details).toMatchObject({ slug: "imported", changed: ["description", "body"] });
    expect((await del(imported!.id)).status).toBe(200);
    expect(await db.select().from(skills).where(eq(skills.id, imported!.id))).toHaveLength(0);
    expect(await audits(ws.id, "skill.deleted")).toHaveLength(1);
    expect((await del(imported!.id)).json.code).toBe("skill_not_found");
  });

  it("lists with assigned (non-archived) employee counts; the body only for admins in the list", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const a = (await post({ slug: "alpha", description: "A", body: "Alpha body" })).json.skill as { id: string };
    await post({ slug: "beta", description: "B", body: "Beta body" });
    const dewi = await employee(ws.id, "Dewi");
    const budi = await employee(ws.id, "Budi");
    const gone = await employee(ws.id, "Gone");
    await db.update(employees).set({ status: "ARCHIVED" }).where(eq(employees.id, gone.id));
    await db.insert(employeeSkills).values([{ employeeId: dewi.id, skillId: a.id }, { employeeId: budi.id, skillId: a.id }, { employeeId: gone.id, skillId: a.id }]);

    const asAdmin = (await call(list, "GET", "/api/skills")).json.skills as { slug: string; body?: string; employeeCount: number; bodyChars: number; source: string }[];
    expect(asAdmin.map((s) => [s.slug, s.employeeCount, s.body, s.bodyChars])).toEqual([
      ["alpha", 2, "Alpha body", 10],
      ["beta", 0, "Beta body", 9],
    ]);

    await signIn(ws.id, "VIEWER");
    const asViewer = (await call(list, "GET", "/api/skills")).json.skills as { slug: string; body?: string; description: string }[];
    expect(asViewer.map((s) => s.slug)).toEqual(["alpha", "beta"]);
    expect(asViewer.every((s) => s.body === undefined && s.description)).toBe(true);
    // the detail too: metadata and assignees, never the body or the provenance hash
    for (const role of ["VIEWER", "MEMBER"] as const) {
      await signIn(ws.id, role);
      const detail = await one(a.id);
      expect(detail.status).toBe(200);
      expect(detail.json.skill).toMatchObject({ slug: "alpha", description: "A", bodyChars: 10, source: "user" });
      expect(detail.json.skill).not.toHaveProperty("body");
      expect(detail.json.skill).not.toHaveProperty("provenanceHash");
      expect(JSON.stringify(detail.json)).not.toContain("Alpha body");
      expect((detail.json.skill as { employees: { name: string }[] }).employees.map((e) => e.name)).toEqual(["Budi", "Dewi", "Gone"]);
    }
    for (const role of ["ADMIN", "OWNER"] as const) {
      await signIn(ws.id, role);
      const detail = await one(a.id);
      expect(detail.json.skill).toMatchObject({ slug: "alpha", body: "Alpha body", provenanceHash: skillProvenanceHash("alpha", "A", "Alpha body") });
    }
  });

  it("only Owners and Admins change skills", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const s = (await post({ slug: "alpha", description: "A", body: "Steps." })).json.skill as { id: string };
    const e = await employee(ws.id);
    for (const role of ["MEMBER", "VIEWER"] as const) {
      await signIn(ws.id, role);
      expect((await post({ slug: "nope", description: "d", body: "Steps." })).status).toBe(403);
      expect((await edit(s.id, { enabled: false })).status).toBe(403);
      expect((await del(s.id)).status).toBe(403);
      expect((await put(e.id, [s.id])).status).toBe(403);
      expect((await call(list, "GET", "/api/skills")).status).toBe(200);
      expect((await assigned(e.id)).status).toBe(200);
    }
    await signIn(ws.id, "OWNER");
    expect((await edit(s.id, { enabled: false })).status).toBe(200);
    expect(await db.select().from(skills).where(eq(skills.workspaceId, ws.id))).toHaveLength(1);
  });

  it("never reads or changes another workspace's skills", async () => {
    const a = await workspace();
    await signIn(a.id);
    const s = (await post({ slug: "secret-sauce", description: "A's", body: "A's body" })).json.skill as { id: string };
    const b = await workspace();
    await signIn(b.id);
    expect((await call(list, "GET", "/api/skills")).json.skills).toEqual([]);
    expect((await one(s.id)).status).toBe(404);
    expect((await edit(s.id, { enabled: false })).status).toBe(404);
    expect((await del(s.id)).status).toBe(404);
    // the same slug is free in another workspace
    expect((await post({ slug: "secret-sauce", description: "B's", body: "Steps." })).status).toBe(200);
    const [row] = await db.select().from(skills).where(eq(skills.id, s.id));
    expect(row).toMatchObject({ enabled: true, description: "A's" });
  });
});

describe("assigning skills to an employee", () => {
  it("replaces the set, reports what changed, audits", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const a = (await post({ slug: "alpha", description: "A", body: "Steps." })).json.skill as { id: string };
    const b = (await post({ slug: "beta", description: "B", body: "Steps." })).json.skill as { id: string };
    const e = await employee(ws.id);
    const r1 = await put(e.id, [a.id, b.id, a.id]);
    expect(r1.json).toMatchObject({ added: ["alpha", "beta"], removed: [] });
    expect(((await assigned(e.id)).json.skills as { slug: string }[]).map((s) => s.slug)).toEqual(["alpha", "beta"]);
    const r2 = await put(e.id, [b.id]);
    expect(r2.json).toMatchObject({ added: [], removed: ["alpha"] });
    expect(((await assigned(e.id)).json.skills as { slug: string }[]).map((s) => s.slug)).toEqual(["beta"]);
    await put(e.id, [b.id]); // no change, no audit
    expect(await audits(ws.id, "skill.assignments_updated")).toHaveLength(2);
    expect((await put(e.id, [])).json).toMatchObject({ removed: ["beta"] });
    expect(await db.select().from(employeeSkills).where(eq(employeeSkills.employeeId, e.id))).toHaveLength(0);
  });

  it("refuses another workspace's skill or employee", async () => {
    const a = await workspace();
    await signIn(a.id);
    const foreign = (await post({ slug: "alpha", description: "A", body: "Steps." })).json.skill as { id: string };
    const foreignEmp = await employee(a.id);
    const b = await workspace();
    await signIn(b.id);
    const own = (await post({ slug: "beta", description: "B", body: "Steps." })).json.skill as { id: string };
    const e = await employee(b.id);
    const r = await put(e.id, [own.id, foreign.id]);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("unknown_skill");
    expect(await db.select().from(employeeSkills).where(eq(employeeSkills.employeeId, e.id))).toHaveLength(0);
    const r2 = await put(foreignEmp.id, [own.id]);
    expect(r2.status).toBe(404);
    expect(r2.json.code).toBe("employee_not_found");
    expect((await assigned(foreignEmp.id)).status).toBe(404);
    expect((await put(e.id, [randomUUID()])).json.code).toBe("unknown_skill");
  });

  it("deleting a skill removes its assignments", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const s = (await post({ slug: "alpha", description: "A", body: "Steps." })).json.skill as { id: string };
    const e = await employee(ws.id);
    await put(e.id, [s.id]);
    await del(s.id);
    expect(await db.select().from(employeeSkills).where(eq(employeeSkills.employeeId, e.id))).toHaveLength(0);
  });
});

describe("SKILL.md parser limits (linear, capped)", () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: performance.now() - t0 };
  };

  it("folds and strips comments without backtracking: 120 000 spaces in a scalar in well under 100 ms", () => {
    const spaces = " ".repeat(120_000);
    for (const [raw, want] of [
      [`a${spaces}b`, `a${spaces}b`],
      [`a${spaces}`, "a"],
      [`a${spaces}#${spaces}x`, "a"],
      [`a${spaces}\n${spaces}b`, "a b"],
      [`"a${spaces}\n${spaces}b"`, "a b"],
      [`'a${spaces}\n${spaces}b'`, "a b"],
      [`"a${spaces}`, null],
    ] as const) {
      const r = timed(() => flowScalar(raw));
      expect(r.value).toBe(want);
      expect(r.ms).toBeLessThan(100);
    }
  });

  it("refuses a 120 000-space description and a 100 KB whitespace line in the frontmatter quickly", () => {
    for (const md of [
      `---\nname: x\ndescription: ${" ".repeat(120_000)}y\n---\nBody`,
      `---\nname: x\ndescription: y\n${" \t".repeat(50_000)}\n---\nBody`,
      `---\nname: x\ndescription: y${" ".repeat(120_000)}`,
    ]) {
      const r = timed(() => parseSkillMarkdown(md));
      expect(r.value).toEqual({ ok: false, error: "frontmatter_too_large" });
      expect(r.ms).toBeLessThan(100);
    }
  });

  it("parses a 100 KB whitespace line in the body quickly", () => {
    const md = `---\nname: x\ndescription: y\n---\n${" ".repeat(100_000)}\n\n${"\t ".repeat(50_000)}\nBody${" ".repeat(100_000)}`;
    const r = timed(() => parseSkillMarkdown(md));
    expect(r.value).toMatchObject({ ok: true, name: "x", description: "y", body: "Body" });
    expect(r.ms).toBeLessThan(100);
  });

  it("caps the frontmatter at 8 KB (UTF-8 bytes)", () => {
    const fm = (description: string) => `---\nname: x\ndescription: ${description}\n---\nBody`;
    // "name: x\n" (8) + "description: " (13) + the value + "\n"
    const fits = SKILL_FRONTMATTER_MAX - 8 - 13 - 1;
    expect(parseSkillMarkdown(fm("d".repeat(fits)))).toMatchObject({ ok: true, description: "d".repeat(fits) });
    expect(parseSkillMarkdown(fm("d".repeat(fits + 1)))).toEqual({ ok: false, error: "frontmatter_too_large" });
    expect(parseSkillMarkdown(fm("é".repeat(fits / 2 + 1)))).toEqual({ ok: false, error: "frontmatter_too_large" });
  });

  it("allows a comment after a quoted scalar, nothing else", () => {
    const desc = (line: string) => parseSkillMarkdown(`---\nname: x\n${line}\n---\nBody`);
    expect(desc('description: "Refunds: fast" # why')).toMatchObject({ ok: true, description: "Refunds: fast" });
    expect(desc("description: 'It''s # not a comment' # but this is")).toMatchObject({ ok: true, description: "It's # not a comment" });
    expect(desc('description: "a \\" # b"')).toMatchObject({ ok: true, description: 'a " # b' });
    expect(desc('description: "a"b')).toMatchObject({ ok: false, error: "bad_yaml" });
    expect(desc('description: "a"#b')).toMatchObject({ ok: false, error: "bad_yaml" });
  });

  it.each([
    ["a NUL in the body", "---\nname: x\ndescription: y\n---\nBo\u0000dy"],
    ["an ESC in the description", "---\nname: x\ndescription: y\u001b[31m\n---\nBody"],
    ["an escaped control character in a quoted description", '---\nname: x\ndescription: "y\\u0007"\n---\nBody'],
    ["a NUL escape", '---\nname: x\ndescription: "y\\0"\n---\nBody'],
  ])("refuses %s", (_label, md) => {
    expect(parseSkillMarkdown(md)).toEqual({ ok: false, error: "invalid_chars" });
  });

  it("keeps tabs and line breaks", () => {
    expect(parseSkillMarkdown("---\r\nname: x\r\ndescription: a\tb\r\n---\r\n1.\tStep\r\n2.\tStep")).toMatchObject({ ok: true, description: "a\tb", body: "1.\tStep\n2.\tStep" });
  });
});

describe("skills API: reserved names, empty bodies, control characters", () => {
  it("refuses the built-in skill names pdf, docx, xlsx and pptx (localised)", async () => {
    const ws = await workspace();
    const u = await signIn(ws.id);
    for (const slug of ["pdf", "docx", "xlsx", "pptx"]) {
      const r = await post({ slug, description: "d", body: "Steps." });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ code: "skill_slug_reserved", slug });
      expect(String(r.json.error)).toContain("built-in skill");
    }
    const md = await post({ markdown: "---\nname: pdf\ndescription: d\n---\nSteps." });
    expect(md.json.code).toBe("skill_slug_reserved");
    // a name that only starts like one is fine
    expect((await post({ slug: "pdf-tools", description: "d", body: "Steps." })).status).toBe(200);
    await db.update(users).set({ locale: "id" }).where(eq(users.id, u.id));
    const id = await post({ slug: "docx", description: "d", body: "Steps." });
    expect(id.json.code).toBe("skill_slug_reserved");
    expect(String(id.json.error)).toContain("adalah nama skill bawaan");
    expect((await db.select().from(skills).where(eq(skills.workspaceId, ws.id))).map((s) => s.slug)).toEqual(["pdf-tools"]);
  });

  it("needs a body with text, on create and on edit", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    for (const body of ["", "   ", "\n\n\t"]) expect((await post({ slug: "empty", description: "d", body })).json.code).toBe("skill_body_required");
    expect((await post({ markdown: "---\nname: empty\ndescription: d\n---\n\n   \n" })).json.code).toBe("skill_body_required");
    const s = (await post({ slug: "full", description: "d", body: "Steps." })).json.skill as { id: string };
    expect((await edit(s.id, { body: "  \n " })).json.code).toBe("skill_body_required");
    expect((await edit(s.id, { description: "only the description" })).status).toBe(200);
    const [row] = await db.select().from(skills).where(eq(skills.id, s.id));
    expect(row!.body).toBe("Steps.");
  });

  it("refuses NUL and other C0 control characters in slug, description and body (tabs and line breaks are fine)", async () => {
    const ws = await workspace();
    await signIn(ws.id);
    const code = async (b: unknown) => (await post(b)).json;
    expect(await code({ slug: "ab\u0000", description: "d", body: "Steps." })).toMatchObject({ code: "skill_invalid_chars", fields: "slug" });
    expect(await code({ slug: "ab", description: "d\u001b[0m", body: "Steps." })).toMatchObject({ code: "skill_invalid_chars", fields: "description" });
    expect(await code({ slug: "ab", description: "d", body: "Step\u0000s\u0007" })).toMatchObject({ code: "skill_invalid_chars", fields: "body" });
    expect(await code({ markdown: "---\nname: ab\ndescription: d\n---\nNUL \u0000" })).toMatchObject({ code: "skill_invalid_chars" });
    expect(await code({ markdown: '---\nname: ab\ndescription: "\\x01"\n---\nBody' })).toMatchObject({ code: "skill_invalid_chars" });
    const ok = await post({ slug: "ab", description: "d", body: "1.\tStep\r\n2.\tStep\n" });
    expect(ok.status).toBe(200);
    const id = (ok.json.skill as { id: string }).id;
    expect((await edit(id, { body: "x\u0000" })).json.code).toBe("skill_invalid_chars");
    expect((await edit(id, { description: "d\u0001x" })).json.code).toBe("skill_invalid_chars");
    expect((await db.select().from(skills).where(eq(skills.workspaceId, ws.id))).map((s) => s.slug)).toEqual(["ab"]);
  });
});
