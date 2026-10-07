import { eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { DEFAULT_MODEL, DEFAULT_MODEL_PRICES } from "@wfos/shared";
import { TEMPLATE_BY_KEY } from "@wfos/templates";
import type { DB } from "./index";
import { clients, employees, modelPrices, projects, routines, teamMembers, teams } from "./schema";

export async function seedPrices(db: DB): Promise<void> {
  for (const p of DEFAULT_MODEL_PRICES) {
    await db.insert(modelPrices).values(p).onConflictDoNothing();
  }
}

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
}

/** Sample data: 3 employees (+1 team), 2 clients with projects, 1 weekly routine. Idempotent per workspace. */
export async function seedSampleData(db: DB, workspaceId: string): Promise<{ created: boolean }> {
  const existing = await db.select({ id: employees.id }).from(employees).where(eq(employees.workspaceId, workspaceId)).limit(1);
  if (existing.length > 0) return { created: false };

  const pm = TEMPLATE_BY_KEY.project_manager!;
  const dev = TEMPLATE_BY_KEY.developer!;
  const fin = TEMPLATE_BY_KEY.finance!;
  const ctx =
    "We are Vardiv Studio, a 6-person software agency in Jakarta building web and mobile apps for SMEs. " +
    "Working language with clients: Bahasa Indonesia or English (match the client). Currency IDR. " +
    "Weekly status emails go out every Monday morning.";

  const [pmE, devE, finE] = await db
    .insert(employees)
    .values([
      { workspaceId, name: pm.defaultName, avatar: pm.avatar, role: pm.role, templateKey: pm.key, persona: pm.persona, instructions: pm.instructions, businessContext: ctx, model: DEFAULT_MODEL, autonomyLevel: "QUEUE", toolPermissions: pm.suggestedTools, dailyBudget: 300 },
      { workspaceId, name: dev.defaultName, avatar: dev.avatar, role: dev.role, templateKey: dev.key, persona: dev.persona, instructions: dev.instructions, businessContext: ctx, model: DEFAULT_MODEL, autonomyLevel: "DRAFT", toolPermissions: dev.suggestedTools, dailyBudget: 300 },
      { workspaceId, name: fin.defaultName, avatar: fin.avatar, role: fin.role, templateKey: fin.key, persona: fin.persona, instructions: fin.instructions, businessContext: ctx, model: DEFAULT_MODEL, autonomyLevel: "QUEUE", toolPermissions: fin.suggestedTools, dailyBudget: 200 },
    ])
    .returning();

  const [team] = await db
    .insert(teams)
    .values({ workspaceId, name: "Delivery Squad", description: "Plans, builds and bills client work.", leadId: pmE!.id })
    .returning();
  await db.insert(teamMembers).values([pmE!, devE!, finE!].map((e) => ({ teamId: team!.id, employeeId: e.id })));

  const [c1, c2] = await db
    .insert(clients)
    .values([
      {
        workspaceId,
        name: "PT Sinar Logistik",
        email: "ops@sinarlogistik.example",
        contacts: [{ name: "Budi Santoso", email: "budi@sinarlogistik.example", role: "Operations Director" }],
        notes: "Prefers Bahasa Indonesia. Weekly status on Mondays.",
        currency: "IDR",
      },
      {
        workspaceId,
        name: "Kopi Nusantara Co.",
        email: "hello@kopinusantara.example",
        contacts: [{ name: "Alicia Tan", email: "alicia@kopinusantara.example", role: "Founder" }],
        notes: "English. Cares about launch date and app store review.",
        currency: "IDR",
      },
    ])
    .returning();

  await db.insert(projects).values([
    { workspaceId, clientId: c1!.id, name: "Fleet Tracking Dashboard", status: "active", description: "Next.js dashboard showing live truck locations and delivery SLAs. Sprint 4 of 6: route history and CSV export.", hourlyRate: 450000 },
    { workspaceId, clientId: c2!.id, name: "Loyalty Mobile App", status: "active", description: "React Native loyalty app. Beta in TestFlight; fixing push notifications before App Store submission.", hourlyRate: 400000 },
  ]);

  const cron = "0 9 * * 1";
  const tz = "Asia/Jakarta";
  await db.insert(routines).values({
    workspaceId,
    name: "Weekly client status",
    cron,
    timezone: tz,
    brief: "Write and send this week's project status email to {{client.name}}. Use get_client for contacts and project details. One email per client.",
    assigneeId: pmE!.id,
    perClient: true,
    dryRun: false,
    enabled: true,
    nextRunAt: nextCronRun(cron, tz),
  });

  await seedPrices(db);
  return { created: true };
}
