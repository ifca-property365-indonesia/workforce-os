import { and, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { DEFAULT_MODEL, DEFAULT_MODEL_PRICES } from "@wfos/shared";
import { DIVISION_TEMPLATES, TEMPLATE_BY_KEY, type DivisionTemplate } from "@wfos/templates";
import type { DB } from "./index";

/** The db or a transaction: both can run queries and open a (nested: savepoint) transaction. */
export type DbOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];
import { clients, employees, modelPrices, projects, routines, teamMembers, teams, workspaces } from "./schema";

export async function seedPrices(db: DB): Promise<void> {
  for (const p of DEFAULT_MODEL_PRICES) {
    await db.insert(modelPrices).values(p).onConflictDoNothing();
  }
}

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
}

export interface SeededDivision {
  key: string;
  id: string;
  headId: string;
  created: boolean;
}

/**
 * The standard organisation (DIVISION_TEMPLATES): each division with its head, members and subagents, built from the
 * role templates. Idempotent per division key: a division that already exists is left as it is. Pass a transaction to
 * make it part of a larger change (each division then commits as a savepoint inside it).
 */
export async function seedOrganization(
  db: DbOrTx,
  workspaceId: string,
  opts: { businessContext?: string; only?: string[] } = {},
): Promise<SeededDivision[]> {
  const out: SeededDivision[] = [];
  // names stay as they are; descriptions and specialties follow the workspace language (Indonesian unless set to English)
  const [ws] = await db.select({ locale: workspaces.defaultLocale }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const lang = ws?.locale === "en" ? "en" : "id";
  const templates = DIVISION_TEMPLATES.filter((d) => !opts.only || opts.only.includes(d.key));
  for (const [i, d] of templates.entries()) {
    const [existing] = await db.select().from(teams).where(and(eq(teams.workspaceId, workspaceId), eq(teams.key, d.key)));
    if (existing) {
      out.push({ key: d.key, id: existing.id, headId: existing.leadId ?? "", created: false });
      continue;
    }
    out.push(await seedDivision(db, workspaceId, d, i, opts.businessContext ?? "", lang));
  }
  return out;
}

async function seedDivision(db: DbOrTx, workspaceId: string, d: DivisionTemplate, order: number, businessContext: string, lang: "en" | "id"): Promise<SeededDivision> {
  return db.transaction(async (tx) => {
    const roles = [{ role: d.head, membership: "member" as const }, ...d.members];
    const rows = await tx
      .insert(employees)
      .values(
        roles.map(({ role }) => {
          const t = TEMPLATE_BY_KEY[role];
          if (!t) throw new Error(`unknown role template ${role}`);
          return {
            workspaceId,
            name: t.defaultName,
            avatar: t.avatar,
            role: t.role,
            templateKey: t.key,
            specialty: lang === "id" ? t.specialtyId : t.specialty,
            persona: t.persona,
            instructions: t.instructions,
            businessContext,
            model: t.model ?? DEFAULT_MODEL,
            autonomyLevel: t.autonomyLevel,
            toolPermissions: t.suggestedTools,
            executionMode: t.executionMode ?? "tool",
            egressDomains: t.egressDomains ?? [],
          };
        }),
      )
      .returning({ id: employees.id, templateKey: employees.templateKey });
    const idOf = (role: string) => rows.find((r) => r.templateKey === role)!.id;
    const [team] = await tx
      .insert(teams)
      .values({
        workspaceId,
        key: d.key,
        name: d.name.en,
        description: d.description[lang],
        leadId: idOf(d.head),
        codeLeadId: d.codeLead ? idOf(d.codeLead) : null,
        sop: d.sop,
        color: d.color,
        maxParallel: d.maxParallel,
        sortOrder: order,
      })
      .returning({ id: teams.id });
    await tx.insert(teamMembers).values(roles.map(({ role, membership }) => ({ teamId: team!.id, employeeId: idOf(role), role: membership })));
    return { key: d.key, id: team!.id, headId: idOf(d.head), created: true };
  });
}

/** Sample data: the standard organisation, 2 example clients with projects, 1 weekly routine. Idempotent per workspace. */
export async function seedSampleData(db: DB, workspaceId: string): Promise<{ created: boolean }> {
  const existing = await db.select({ id: employees.id }).from(employees).where(eq(employees.workspaceId, workspaceId)).limit(1);
  if (existing.length > 0) return { created: false };

  const ctx =
    "We are Vardiv Studio, a 6-person software agency in Jakarta building web and mobile apps for SMEs. " +
    "Working language with clients: Bahasa Indonesia or English (match the client). Currency IDR. " +
    "Weekly status emails go out every Monday morning.";
  const divisions = await seedOrganization(db, workspaceId, { businessContext: ctx });
  const delivery = divisions.find((d) => d.key === "delivery")!;

  const [c1, c2] = await db
    .insert(clients)
    .values([
      {
        workspaceId,
        name: "PT Sinar Logistik (example)",
        code: "SNL",
        industry: "Logistics",
        email: "ops@sinarlogistik.example",
        contacts: [
          { name: "Budi Santoso", email: "budi@sinarlogistik.example", role: "director", phone: "", receives: { status: true, minutes: true, invoice: false } },
          { name: "Sri Wahyuni", email: "finance@sinarlogistik.example", role: "billing", phone: "", receives: { status: false, minutes: false, invoice: true } },
        ],
        legalName: "PT Sinar Logistik Nusantara",
        notes: "Example client. Prefers Bahasa Indonesia. Weekly status on Mondays.",
        currency: "IDR",
      },
      {
        workspaceId,
        name: "Kopi Nusantara Co. (example)",
        code: "KNC",
        industry: "Food & beverage",
        email: "hello@kopinusantara.example",
        contacts: [{ name: "Alicia Tan", email: "alicia@kopinusantara.example", role: "director", phone: "", receives: { status: true, minutes: true, invoice: true } }],
        notes: "Example client. English. Cares about launch date and app store review.",
        currency: "IDR",
      },
    ])
    .returning();

  await db.insert(projects).values([
    {
      workspaceId,
      clientId: c1!.id,
      teamId: delivery.id,
      name: "Fleet Tracking Dashboard",
      status: "active",
      description: "Next.js dashboard showing live truck locations and delivery SLAs. Sprint 4 of 6: route history and CSV export.",
      hourlyRate: 450000,
      nextMilestone: "Route history and CSV export",
    },
    {
      workspaceId,
      clientId: c2!.id,
      teamId: delivery.id,
      name: "Loyalty Mobile App",
      status: "active",
      description: "React Native loyalty app. Beta in TestFlight; fixing push notifications before App Store submission.",
      hourlyRate: 400000,
      health: "at_risk",
      nextStep: "Fix push notifications before the App Store submission",
    },
  ]);

  const cron = "0 9 * * 1";
  const tz = "Asia/Jakarta";
  await db.insert(routines).values({
    workspaceId,
    name: "Weekly client status",
    cron,
    timezone: tz,
    brief: "Write and send this week's project status email to {{client.name}}. Use get_client for contacts and project details. One email per client.",
    teamId: delivery.id,
    perClient: true,
    dryRun: false,
    enabled: true,
    nextRunAt: nextCronRun(cron, tz),
  });

  await seedPrices(db);
  return { created: true };
}
