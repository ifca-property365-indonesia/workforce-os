/**
 * One-off organisation rebuild (October 2026, plan: docs "Rombak Organisasi"):
 *   - removes the example clients (with their projects, invoices and tasks),
 *   - removes every employee and team of the workspace (task history stays, with the assignee cleared),
 *   - removes routines and webhook triggers that pointed at them,
 *   - creates the standard organisation (Delivery squad, Support, Finance & Accounting, HR),
 *   - adds the two real clients with public data and clearly marked placeholders.
 *
 * Dry run by default: prints what would change. `--apply` runs it in one transaction and writes the audit log.
 *   pnpm --filter @wfos/db exec tsx src/org-rebuild-2026-10.ts --workspace <slug> [--apply]
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { assertNotProductionTarget } from "@wfos/shared/runtime";
import { getDb, getSql } from "./index";
import { audit } from "./audit";
import { seedOrganization } from "./sample";
import { clients, employees, routines, tasks, teams, webhookTriggers, workspaces } from "./schema";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env"), quiet: true });
assertNotProductionTarget();

const EXAMPLE_CLIENTS = ["PT Sinar Logistik", "Kopi Nusantara Co."];

const PLACEHOLDER = "⚠ PERLU DIISI";
const REAL_CLIENTS = [
  {
    name: "PT Grand Outlet Bali",
    code: "GOB",
    legalName: "PT Grand Outlet Bali",
    industry: "Retail — factory outlet mall (Sira Village – Grand Outlet Bali)",
    website: "https://www.siravillage.com",
    address: "Sira Village, Kawasan Ekonomi Khusus Kura Kura Bali, Pulau Serangan, Denpasar Selatan, Kota Denpasar, Bali (⚠ nama jalan dan kode pos belum diisi)",
    taxId: "",
    phone: "",
    email: "",
    contacts: [
      { name: "PIC Proyek (⚠ ganti)", email: "pic@grandoutletbali.example", role: "project", phone: "", receives: { status: true, minutes: true, invoice: false } },
      { name: "Billing (⚠ ganti)", email: "finance@grandoutletbali.example", role: "billing", phone: "", receives: { status: false, minutes: false, invoice: true } },
    ],
    notes: [
      "Sumber publik (Okt 2026): mengelola Sira Village – Grand Outlet Bali di KEK Kura Kura Bali, Pulau Serangan; dibuka 31 Juli 2026, ±130 toko; kerja sama Mitsubishi Estate dan PT Bali Turtle Island Development.",
      "Presiden Direktur (menurut berita): Tantowi Yahya.",
      `${PLACEHOLDER}: NPWP, telepon, alamat lengkap, dan kontak asli. Alamat email kontak memakai domain .example yang tidak bisa menerima email.`,
    ].join("\n"),
  },
  {
    name: "PT Bali Turtle Island Development",
    code: "BTID",
    legalName: "PT Bali Turtle Island Development",
    industry: "Pengembang dan pengelola KEK Kura Kura Bali (Pulau Serangan, ±498 ha)",
    website: "",
    address: "Kawasan Ekonomi Khusus Kura Kura Bali, Pulau Serangan, Denpasar Selatan, Kota Denpasar, Bali (⚠ alamat kantor belum diisi)",
    taxId: "",
    phone: "",
    email: "",
    contacts: [
      { name: "PIC Proyek (⚠ ganti)", email: "pic@btid.example", role: "project", phone: "", receives: { status: true, minutes: true, invoice: false } },
      { name: "Billing (⚠ ganti)", email: "finance@btid.example", role: "billing", phone: "", receives: { status: false, minutes: false, invoice: true } },
    ],
    notes: [
      "Sumber publik (Okt 2026): Badan Usaha Pembangun dan Pengelola KEK Kura Kura Bali di Pulau Serangan; mitra pengembangan Sira Village – Grand Outlet Bali.",
      "Konteks berita 2025–2026: disorot soal izin pemanfaatan pesisir dan mangrove; perhatikan saat menyusun komunikasi publik.",
      `${PLACEHOLDER}: website resmi (kemungkinan kurakurabali.com, belum terverifikasi), NPWP, telepon, alamat kantor, dan kontak asli. Alamat email kontak memakai domain .example.`,
    ].join("\n"),
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("--workspace");
  const apply = process.argv.includes("--apply");
  if (!slug) throw new Error("usage: --workspace <slug> [--apply]");
  const db = getDb();
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
  if (!ws) throw new Error(`no workspace with slug ${slug}`);

  const exampleClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.workspaceId, ws.id), inArray(clients.name, EXAMPLE_CLIENTS)));
  const exampleIds = exampleClients.map((c) => c.id);

  // the example clients' tasks and everything below them (subtasks, handoffs)
  let doomed = exampleIds.length
    ? (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, ws.id), inArray(tasks.clientId, exampleIds)))).map((t) => t.id)
    : [];
  for (let frontier = doomed; frontier.length; ) {
    const next = (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws.id), or(inArray(tasks.parentTaskId, frontier), inArray(tasks.originTaskId, frontier))))
    )
      .map((t) => t.id)
      .filter((id) => !doomed.includes(id));
    doomed = [...doomed, ...next];
    frontier = next;
  }

  const oldEmployees = await db.select({ id: employees.id, name: employees.name, role: employees.role }).from(employees).where(eq(employees.workspaceId, ws.id));
  const oldTeams = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.workspaceId, ws.id));
  const empIds = oldEmployees.map((e) => e.id);
  const teamIds = oldTeams.map((t) => t.id);
  const orphanRoutines = await db
    .select({ id: routines.id, name: routines.name })
    .from(routines)
    .where(
      and(
        eq(routines.workspaceId, ws.id),
        or(empIds.length ? inArray(routines.assigneeId, empIds) : undefined, teamIds.length ? inArray(routines.teamId, teamIds) : undefined),
      ),
    );
  const orphanHooks = await db
    .select({ id: webhookTriggers.id, name: webhookTriggers.name })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.workspaceId, ws.id),
        or(empIds.length ? inArray(webhookTriggers.assigneeId, empIds) : undefined, teamIds.length ? inArray(webhookTriggers.teamId, teamIds) : undefined),
      ),
    );
  const existingReal = await db
    .select({ code: clients.code, name: clients.name })
    .from(clients)
    .where(and(eq(clients.workspaceId, ws.id), or(inArray(clients.code, REAL_CLIENTS.map((c) => c.code)), inArray(clients.name, REAL_CLIENTS.map((c) => c.name)))));
  const runningTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ws.id), inArray(tasks.status, ["RUNNING"]), isNotNull(tasks.assigneeId)));

  console.log(`Workspace: ${ws.name} (${ws.slug})`);
  console.log(`Example clients to delete: ${exampleClients.map((c) => c.name).join(", ") || "(none)"}`);
  console.log(`  their tasks (incl. subtasks/handoffs): ${doomed.length}`);
  console.log(`Employees to delete: ${oldEmployees.map((e) => `${e.name} (${e.role})`).join(", ") || "(none)"}`);
  console.log(`Teams to delete: ${oldTeams.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`Routines to delete: ${orphanRoutines.map((r) => r.name).join(", ") || "(none)"}`);
  console.log(`Webhook triggers to delete: ${orphanHooks.map((h) => h.name).join(", ") || "(none)"}`);
  console.log(`Real clients already present: ${existingReal.map((c) => c.name).join(", ") || "(none)"}`);
  if (runningTasks.length) throw new Error(`${runningTasks.length} task(s) are RUNNING: wait until they finish (or cancel them) before rebuilding.`);
  if (!apply) {
    console.log("\nDry run. Re-run with --apply to make these changes.");
    return;
  }

  await db.transaction(async (tx) => {
    if (doomed.length) await tx.delete(tasks).where(inArray(tasks.id, doomed));
    if (exampleIds.length) await tx.delete(clients).where(inArray(clients.id, exampleIds));
    if (orphanRoutines.length) await tx.delete(routines).where(inArray(routines.id, orphanRoutines.map((r) => r.id)));
    if (orphanHooks.length) await tx.delete(webhookTriggers).where(inArray(webhookTriggers.id, orphanHooks.map((h) => h.id)));
    if (teamIds.length) await tx.delete(teams).where(inArray(teams.id, teamIds));
    if (empIds.length) await tx.delete(employees).where(inArray(employees.id, empIds));
    const present = new Set(existingReal.map((c) => c.code));
    const toAdd = REAL_CLIENTS.filter((c) => !present.has(c.code) && !existingReal.some((e) => e.name === c.name));
    if (toAdd.length) await tx.insert(clients).values(toAdd.map((c) => ({ ...c, workspaceId: ws.id, currency: "IDR", status: "active" as const })));
  });
  const divisions = await seedOrganization(db, ws.id);

  const actorLabel = `cli:${process.env.USER ?? "unknown"}`;
  await audit({
    workspaceId: ws.id,
    actorLabel,
    action: "org.rebuilt",
    targetType: "workspace",
    targetId: ws.id,
    details: {
      deletedClients: exampleClients.map((c) => c.name),
      deletedTasks: doomed.length,
      deletedEmployees: oldEmployees.map((e) => e.name),
      deletedTeams: oldTeams.map((t) => t.name),
      deletedRoutines: orphanRoutines.map((r) => r.name),
      deletedWebhookTriggers: orphanHooks.map((h) => h.name),
      divisions: divisions.map((d) => ({ key: d.key, created: d.created })),
      addedClients: REAL_CLIENTS.map((c) => c.code),
    },
  });
  console.log(`\nDone. Divisions: ${divisions.map((d) => `${d.key}${d.created ? "" : " (kept)"}`).join(", ")}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
