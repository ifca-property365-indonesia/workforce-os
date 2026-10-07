import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentMessages, approvals, clients, db, employees, projects, tasks, type Deliverable } from "@wfos/db";
import { DEFAULT_MODEL, invoiceTotal, type InvoicePayload } from "@wfos/shared";
import { TEMPLATE_BY_KEY } from "@wfos/templates";
import { publish, miscQueue } from "../lib/redis";
import { recordStep } from "../lib/steps";
import { setTaskStatus } from "../runner/task";
import { onChildFinished } from "../orchestration/team";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Task = typeof tasks.$inferSelect;
type Employee = typeof employees.$inferSelect;

/** Demo-mode chat reply: no tokens, no network. */
export function scriptedChatReply(name: string, role: string, text: string): string {
  const t = text.toLowerCase();
  if (/status|progress|update/.test(t)) {
    return `Hi! ${name} here (${role}, demo mode). Here's a sample status update:\n\n• Fleet Tracking Dashboard — route history shipped, CSV export in review.\n• Loyalty Mobile App — push notification fix verified in TestFlight.\n\nIn live mode I'd pull this from client master data and the task board, then queue the email for your approval.`;
  }
  if (/invoice|bill/.test(t)) {
    return `${name} (${role}, demo mode): I'd draft invoice INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-001 from the project hourly rates, attach the PDF, and request approval before anything is sent.`;
  }
  return `Hi, I'm ${name}, your ${role}. Demo mode is on, so this reply is scripted and costs 0 credits. Turn Demo Mode off in Settings and add a Claude credential to get real answers. You asked: "${text.slice(0, 200)}"`;
}

async function fakeLlm(workspaceId: string, taskId: string, employeeId: string, name: string, inTok: number, outTok: number) {
  await recordStep({ workspaceId, taskId, employeeId, kind: "llm", name, model: "demo-script", inputTokens: inTok, outputTokens: outTok, latencyMs: 600 + Math.round(Math.random() * 900), credits: 0 });
}

async function fakeTool(workspaceId: string, taskId: string, employeeId: string, name: string, input: unknown, output: unknown, status = "ok") {
  await recordStep({ workspaceId, taskId, employeeId, kind: "tool", name, input, output, latencyMs: 120 + Math.round(Math.random() * 300), credits: 0, status });
}

async function addDeliverable(taskId: string, d: Omit<Deliverable, "id" | "createdAt">) {
  const full: Deliverable = { ...d, id: randomUUID(), createdAt: new Date().toISOString() };
  await db.update(tasks).set({ deliverables: sql`${tasks.deliverables} || ${JSON.stringify([full])}::jsonb` }).where(eq(tasks.id, taskId));
}

/** Any task that runs while Demo Mode is on (or a demo task) gets a scripted, zero-cost execution. */
export async function scriptedTaskRun(task: Task, emp: Employee): Promise<void> {
  await setTaskStatus(task, "RUNNING", { error: null });
  const running = { ...task, status: "RUNNING" as const };
  await fakeLlm(task.workspaceId, task.id, emp.id, "demo_script", 1850, 420);
  if (task.source === "demo" && task.phase === "review") {
    await addDeliverable(task.id, {
      kind: "review",
      title: "Final delivery summary",
      content:
        "CSV export for the Fleet Tracking Dashboard is complete.\n\n- Developer: implemented streaming CSV endpoint + download button.\n- QA: 6/6 acceptance checks passed.\n- Finance: invoice approved and (dry-run) emailed to the client.\n\nReady to hand over.",
    });
    await pause(800);
    await setTaskStatus(running, "DONE", { result: "Reviewed all subtasks; final summary delivered.", phase: "done" });
    await publish(task.workspaceId, { type: "demo.stage", stage: "done", detail: "Lead reviewed all deliverables. Demo lifecycle complete." });
    return;
  }
  await addDeliverable(task.id, { kind: "summary", title: `Demo output: ${task.title}`, content: `Scripted demo output for "${task.title}". No tokens were used.` });
  await pause(600);
  await setTaskStatus(running, "DONE", { result: "Demo mode: scripted result (0 credits)." });
  if (task.parentTaskId) await onChildFinished(task.workspaceId, task.parentTaskId);
}

async function ensureEmployee(workspaceId: string, key: string, fallback: { name: string; role: string; avatar: string }): Promise<Employee> {
  const [existing] = await db.select().from(employees).where(and(eq(employees.workspaceId, workspaceId), eq(employees.templateKey, key)));
  if (existing) return existing;
  const tpl = TEMPLATE_BY_KEY[key];
  const [e] = await db
    .insert(employees)
    .values({
      workspaceId,
      name: tpl?.defaultName ?? fallback.name,
      role: tpl?.role ?? fallback.role,
      avatar: tpl?.avatar ?? fallback.avatar,
      templateKey: key,
      persona: tpl?.persona ?? "A careful QA engineer who checks acceptance criteria one by one.",
      instructions: tpl?.instructions ?? "Review deliverables against acceptance criteria. Report pass/fail per criterion.",
      model: DEFAULT_MODEL,
      autonomyLevel: "DRAFT",
      toolPermissions: tpl?.suggestedTools ?? [{ tool: "draft_document", enabled: true }, { tool: "kb_search", enabled: true }],
    })
    .returning();
  return e!;
}

async function stage(workspaceId: string, stageName: string, detail: string) {
  await publish(workspaceId, { type: "demo.stage", stage: stageName, detail });
}

/**
 * Scripted lifecycle: PM plans → Developer builds → QA reviews → Finance drafts invoice →
 * Approval requested → (on approve) email "sent" in dry run → PM final review.
 * Emits the same SSE events as real runs; uses no tokens and no network.
 */
export async function runDemoLifecycle(workspaceId: string, userId: string): Promise<void> {
  const pm = await ensureEmployee(workspaceId, "project_manager", { name: "Pratama", role: "Project Manager", avatar: "🧭" });
  const dev = await ensureEmployee(workspaceId, "developer", { name: "Dewi", role: "Developer", avatar: "👩‍💻" });
  const qa = await ensureEmployee(workspaceId, "qa", { name: "Quinn", role: "QA Reviewer", avatar: "🧪" });
  const fin = await ensureEmployee(workspaceId, "finance", { name: "Fajar", role: "Finance & Billing", avatar: "🧾" });
  const [client] = await db.select().from(clients).where(eq(clients.workspaceId, workspaceId)).limit(1);
  const [project] = client ? await db.select().from(projects).where(eq(projects.clientId, client.id)).limit(1) : [];

  await stage(workspaceId, "start", "Demo started: a brief goes to the Project Manager.");
  const [parent] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: "[Demo] Ship CSV export for the Fleet Dashboard",
      brief: "Client wants to export route history as CSV. Plan it, build it, QA it, and bill the hours.",
      assigneeId: pm.id,
      clientId: client?.id ?? null,
      projectId: project?.id ?? null,
      source: "demo",
      dryRun: true,
      status: "QUEUED",
      createdBy: userId,
    })
    .returning();
  await publish(workspaceId, { type: "task.created", taskId: parent!.id, title: parent!.title, employeeId: pm.id });
  await pause(1200);

  // 1. PM plans
  await setTaskStatus(parent!, "RUNNING");
  await stage(workspaceId, "plan", `${pm.name} is planning and delegating.`);
  await fakeLlm(workspaceId, parent!.id, pm.id, "plan", 2400, 610);
  await fakeTool(workspaceId, parent!.id, pm.id, "get_client", { clientId: client?.id }, { name: client?.name ?? "Demo client" });
  const mk = async (emp: Employee, title: string, brief: string) => {
    const [t] = await db
      .insert(tasks)
      .values({ workspaceId, title, brief, assigneeId: emp.id, parentTaskId: parent!.id, clientId: client?.id ?? null, source: "demo", dryRun: true, status: "QUEUED" })
      .returning();
    await db.insert(agentMessages).values({ workspaceId, taskId: t!.id, fromEmployeeId: pm.id, toEmployeeId: emp.id, intent: "request", content: `New subtask: ${title}` });
    await recordStep({ workspaceId, taskId: parent!.id, employeeId: pm.id, kind: "agent_message", name: `${pm.name} → ${emp.name}`, input: { intent: "request" }, output: brief });
    await fakeTool(workspaceId, parent!.id, pm.id, "delegate_subtask", { assigneeId: emp.id, title }, `Subtask "${title}" delegated`);
    await publish(workspaceId, { type: "task.created", taskId: t!.id, parentTaskId: parent!.id, title, employeeId: emp.id });
    await pause(500);
    return t!;
  };
  const tDev = await mk(dev, "[Demo] Build CSV export endpoint", "Streaming CSV of route history; button on the history page. AC: handles 100k rows, UTF-8 BOM for Excel.");
  const tQa = await mk(qa, "[Demo] QA the CSV export", "Verify acceptance criteria and edge cases (empty range, timezone).");
  const tFin = await mk(fin, "[Demo] Invoice the CSV export work", "Bill 12 hours at the project rate. Send the invoice to the client.");
  await db.update(tasks).set({ phase: "wait", result: "Plan: build → QA → invoice." }).where(eq(tasks.id, parent!.id));
  await pause(800);

  // 2. Developer builds
  await setTaskStatus(tDev, "RUNNING");
  await stage(workspaceId, "build", `${dev.name} is building the feature.`);
  await fakeTool(workspaceId, tDev.id, dev.id, "kb_search", { query: "CSV export conventions" }, "[Engineering handbook §4] Use streaming responses for large exports.");
  await fakeLlm(workspaceId, tDev.id, dev.id, "build", 3100, 1450);
  await addDeliverable(tDev.id, {
    kind: "code",
    title: "app/api/routes/export/route.ts",
    content:
      'export async function GET(req: Request) {\n  const { searchParams } = new URL(req.url);\n  const stream = routeHistoryCsv(searchParams.get("from"), searchParams.get("to"));\n  return new Response(stream, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=routes.csv" } });\n}\n',
  });
  await fakeTool(workspaceId, tDev.id, dev.id, "draft_document", { title: "app/api/routes/export/route.ts" }, "Saved deliverable");
  await pause(700);
  await setTaskStatus({ ...tDev, status: "RUNNING" }, "DONE", { result: "Endpoint + button implemented (draft diff ready for review)." });

  // 3. QA reviews
  await setTaskStatus(tQa, "RUNNING");
  await stage(workspaceId, "qa", `${qa.name} is reviewing the build.`);
  await db.insert(agentMessages).values({ workspaceId, taskId: tQa.id, fromEmployeeId: dev.id, toEmployeeId: qa.id, intent: "update", content: "Export endpoint is ready for QA." });
  await recordStep({ workspaceId, taskId: tQa.id, employeeId: dev.id, kind: "agent_message", name: `${dev.name} → ${qa.name}`, input: { intent: "update" }, output: "Export endpoint is ready for QA." });
  await fakeLlm(workspaceId, tQa.id, qa.id, "review", 2200, 540);
  await addDeliverable(tQa.id, { kind: "review", title: "QA report", content: "✅ 100k rows streamed in 3.1s\n✅ UTF-8 BOM present\n✅ Empty range returns header only\n✅ Asia/Jakarta timestamps\n✅ Button disabled while exporting\n✅ Filename includes date range" });
  await pause(700);
  await setTaskStatus({ ...tQa, status: "RUNNING" }, "DONE", { result: "6/6 checks passed." });

  // 4. Finance drafts invoice → approval
  await setTaskStatus(tFin, "RUNNING");
  await stage(workspaceId, "invoice", `${fin.name} is drafting the invoice.`);
  const rate = project?.hourlyRate || 450000;
  const inv: InvoicePayload = {
    clientId: client?.id ?? "00000000-0000-0000-0000-000000000000",
    invoiceNumber: `INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-901`,
    currency: client?.currency ?? "IDR",
    lines: [{ description: "CSV export for route history (build + QA)", quantity: 12, unitPrice: rate }],
    dueDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
    notes: "Thank you for your business.",
    to: [client?.contacts[0]?.email || client?.email || "client@example.com"],
    subject: "Invoice for CSV export work",
    body: `Dear ${client?.contacts[0]?.name ?? "client"},\n\nPlease find attached the invoice for the CSV export feature (12 hours).\n\nBest regards,\n${fin.name}`,
  };
  await fakeLlm(workspaceId, tFin.id, fin.id, "invoice", 1900, 380);
  await fakeTool(workspaceId, tFin.id, fin.id, "draft_invoice", { invoiceNumber: inv.invoiceNumber }, `Total ${inv.currency} ${invoiceTotal(inv)}`);
  await addDeliverable(tFin.id, { kind: "invoice", title: `Invoice ${inv.invoiceNumber}`, content: `Total: ${inv.currency} ${invoiceTotal(inv)}`, meta: { invoice: inv, total: invoiceTotal(inv) } });
  const [appr] = await db
    .insert(approvals)
    .values({
      workspaceId,
      taskId: tFin.id,
      employeeId: fin.id,
      toolName: "send_invoice",
      title: `Invoice ${inv.invoiceNumber} (${inv.currency} ${invoiceTotal(inv)})`,
      reason: "Irreversible action requires approval (autonomy QUEUE). Demo: executes as a dry run.",
      payload: inv as unknown as Record<string, unknown>,
    })
    .returning();
  await recordStep({ workspaceId, taskId: tFin.id, employeeId: fin.id, kind: "approval", name: "approval_requested:send_invoice", status: "pending", input: { approvalId: appr!.id }, output: inv });
  await publish(workspaceId, { type: "approval.created", approvalId: appr!.id, taskId: tFin.id, title: appr!.title });
  await setTaskStatus({ ...tFin, status: "RUNNING" }, "AWAITING_APPROVAL", { result: "Invoice ready; waiting for approval." });
  await miscQueue.add("notify", { kind: "notify", workspaceId, subject: `[Demo] Approval needed: ${appr!.title}`, text: "Demo approval waiting.", link: `/approvals?focus=${appr!.id}` });
  await stage(workspaceId, "approval", "Approval requested. Open the Approvals inbox and approve: the email will be 'sent' as a dry run.");
}
