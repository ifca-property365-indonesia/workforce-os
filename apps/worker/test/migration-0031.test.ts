import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, migrationStatements, testSql } from "@wfos/db/testing";

/**
 * 0031's data step on rows as they were before it (a database migrated up to 0030): one division per employee
 * without taking a head's division away, and nothing the previous release still reads is dropped.
 */
let drop: () => Promise<void>;
let sql: ReturnType<typeof testSql>;

beforeAll(async () => {
  const db = await createTestDatabase({ upTo: "0030_app_uptime" });
  drop = db.drop;
  sql = testSql(db.url);
});

afterAll(async () => {
  await sql?.end();
  await drop?.();
});

describe("migration 0031 on live-shaped data", () => {
  it("keeps every head in the team they lead, dedupes the rest to the oldest team, and keeps the old columns", async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('WS', 'ws-0031') returning id`;
    const emp = async (name: string) => (await sql`insert into employees (workspace_id, name, role, model, department) values (${ws!.id}, ${name}, 'r', 'm', 'engineering') returning id`)[0]!.id as string;
    const team = async (name: string, lead: string | null, at: string) =>
      (await sql`insert into teams (workspace_id, name, lead_id, created_at) values (${ws!.id}, ${name}, ${lead}, ${at}) returning id`)[0]!.id as string;
    const member = (teamId: string, employeeId: string) => sql`insert into team_members (team_id, employee_id) values (${teamId}, ${employeeId})`;

    const [hana, lina, maya, kiki, solo] = [await emp("Hana"), await emp("Lina"), await emp("Maya"), await emp("Kiki"), await emp("Solo")];
    // Hana leads the oldest team and T3; Lina leads T2 through a lead-only PATCH (never added as its member) but is a
    // member of the oldest team; Maya is in T1 and T3; Kiki leads T4 with no membership at all
    const t1 = await team("T1", hana, "2026-01-01T00:00:00Z");
    const t2 = await team("T2", lina, "2026-02-01T00:00:00Z");
    const t3 = await team("T3", hana, "2026-03-01T00:00:00Z");
    const t4 = await team("T4", kiki, "2026-04-01T00:00:00Z");
    await member(t1, hana);
    await member(t3, hana);
    await member(t1, lina);
    await member(t1, maya);
    await member(t3, maya);
    await member(t2, solo);
    await sql`insert into departments (workspace_id, key, name, sop) values (${ws!.id}, 'engineering', ${sql.json({ en: "Engineering" })}, ${sql.json({ en: "" })})`;

    // the old dedupe kept Lina in T1 and then cleared T2's head
    for (const s of migrationStatements("0031_divisions_clients")) await sql.unsafe(s);

    const rows = await sql<{ team: string; emp: string }[]>`
      select t.name as team, e.name as emp from team_members tm join teams t on t.id = tm.team_id join employees e on e.id = tm.employee_id
      order by e.name`;
    const report = rows.map((r) => `${r.emp}→${r.team}`);
    expect(report).toEqual(["Hana→T1", "Kiki→T4", "Lina→T2", "Maya→T1", "Solo→T2"]);
    const leads = await sql<{ name: string; lead: string | null }[]>`
      select t.name, e.name as lead from teams t left join employees e on e.id = t.lead_id order by t.name`;
    const leadReport = Object.fromEntries(leads.map((l) => [l.name, l.lead]));
    // only T3 lost its head: Hana's membership there was the one removed (she stays head of the older T1)
    expect(leadReport).toEqual({ T1: "Hana", T2: "Lina", T3: null, T4: "Kiki" });
    process.stdout.write(`0031 result: memberships ${report.join(", ")}; heads ${JSON.stringify(leadReport)}\n`);

    // the previous release still selects these during the deploy window
    const [dept] = await sql`select count(*)::int as n from information_schema.columns where table_name = 'employees' and column_name = 'department'`;
    expect(dept!.n).toBe(1);
    expect((await sql`select key from departments`).map((d) => d.key)).toEqual(["engineering"]);
    expect((await sql`select department from employees where name = 'Hana'`)[0]!.department).toBe("engineering");
    // new: the client of an agent message (cascade with the client)
    const [cid] = await sql`select is_nullable, data_type from information_schema.columns where table_name = 'agent_messages' and column_name = 'client_id'`;
    expect(cid).toMatchObject({ is_nullable: "YES", data_type: "uuid" });
    // one division per employee is enforced from now on
    await expect(sql`insert into team_members (team_id, employee_id) values (${t3}, ${maya})`).rejects.toThrow(/team_members_employee/);
  });
});
