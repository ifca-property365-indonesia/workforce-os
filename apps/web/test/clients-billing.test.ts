import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { clients, db, employees, invoices, members, outboundEmails, projects, recurringBillings, tasks, users, workspaces } from "@wfos/db";
import type { Role } from "@wfos/shared";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listClients, POST as createClient } from "@/app/api/clients/route";
import { GET as getClient, PATCH as patchClient } from "@/app/api/clients/[id]/route";
import { GET as getCompany, PUT as putCompany } from "@/app/api/settings/company/route";
import { GET as listRecurring, POST as createRecurring } from "@/app/api/recurring-billings/route";
import { DELETE as deleteRecurring, PATCH as patchRecurring } from "@/app/api/recurring-billings/[id]/route";
import { GET as listInvoices } from "@/app/api/invoices/route";
import { PATCH as patchInvoice } from "@/app/api/invoices/[id]/route";
import { GET as invoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { call, callWithParams, queueModule, resetBrowser } from "./browser";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => resetBrowser());

async function workspace(settings: Record<string, unknown> = {}) {
  const [ws] = await db.insert(workspaces).values({ name: "WS", slug: `ws-${randomUUID().slice(0, 8)}`, require2faAdmins: false, timezone: "Asia/Jakarta", settings }).returning();
  return ws!;
}

/** a person with `role` in `ws`, logged in (the browser's cookie jar now holds their session) */
async function signIn(wsId: string, role: Role) {
  resetBrowser();
  const email = `c-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: "T", passwordHash: await bcrypt.hash("pw-123456", 4) }).returning();
  await db.insert(members).values({ workspaceId: wsId, userId: u!.id, role });
  const r = await call(login, "POST", "/api/auth/login", { email, password: "pw-123456" });
  expect(r.status).toBe(200);
  return u!;
}

const line = (unitPrice: number) => [{ description: "Retainer", quantity: 1, unitPrice }];

describe("clients API", () => {
  it("lists clients with recurring monthly, outstanding and overdue totals", async () => {
    const ws = await workspace();
    const [a] = await db
      .insert(clients)
      .values({ workspaceId: ws.id, name: "Acme", contacts: [{ name: "Old", email: "old@acme.test", role: "PM" }], status: "active" })
      .returning();
    const [b] = await db.insert(clients).values({ workspaceId: ws.id, name: "Beta", status: "prospect" }).returning();
    await db.insert(recurringBillings).values([
      { workspaceId: ws.id, clientId: a!.id, description: "Hosting", amount: 1_000_000, period: "monthly" },
      { workspaceId: ws.id, clientId: a!.id, description: "Licence", amount: 12_000_000, period: "yearly", startMonth: 1 },
      { workspaceId: ws.id, clientId: a!.id, description: "Paused", amount: 5_000_000, active: false },
    ]);
    await db.insert(invoices).values([
      { workspaceId: ws.id, clientId: a!.id, number: "INV-1", status: "sent", total: 1_110_000, dueDate: day(-5) },
      { workspaceId: ws.id, clientId: a!.id, number: "INV-2", status: "sent", total: 500_000, dueDate: day(10) },
      { workspaceId: ws.id, clientId: a!.id, number: "INV-3", status: "paid", total: 999, dueDate: day(-30) },
      { workspaceId: ws.id, clientId: a!.id, number: "INV-4", status: "draft", total: 777, dueDate: day(-30) },
    ]);
    await signIn(ws.id, "VIEWER");
    const r = await call(listClients, "GET", "/api/clients");
    expect(r.status).toBe(200);
    type Row = { id: string; status: string; recurringMonthly: number; outstanding: number; overdue: number; contacts: { email: string; phone: string; receives: { invoice: boolean } }[] };
    const rows = r.json.clients as Row[];
    const acme = rows.find((c) => c.id === a!.id)!;
    expect(acme.recurringMonthly).toBe(2_000_000);
    expect(acme.outstanding).toBe(1_610_000);
    expect(acme.overdue).toBe(1);
    // a contact stored before 0025 reads with the new defaults
    expect(acme.contacts).toEqual([{ name: "Old", email: "old@acme.test", role: "PM", phone: "", receives: { status: false, minutes: false, invoice: false } }]);
    const beta = rows.find((c) => c.id === b!.id)!;
    expect(beta).toMatchObject({ status: "prospect", recurringMonthly: 0, outstanding: 0, overdue: 0 });
  });

  it("creates and updates the profile fields and contacts with what they receive", async () => {
    const ws = await workspace();
    await signIn(ws.id, "MEMBER");
    const created = await call(createClient, "POST", "/api/clients", { name: "Gamma", status: "prospect", legalName: "PT Gamma Jaya", taxId: "01.234.567.8-901.000" });
    expect(created.status).toBe(200);
    const id = (created.json.client as { id: string }).id;
    const contacts = [{ name: "Fin", email: "fin@gamma.test", role: "billing", phone: "+62 811", receives: { status: false, minutes: false, invoice: true } }];
    const patched = await callWithParams(patchClient, "PATCH", `/api/clients/${id}`, { address: "Jl. Sudirman 1", contacts }, { id });
    expect(patched.status).toBe(200);
    expect(patched.json.client).toMatchObject({ name: "Gamma", status: "prospect", legalName: "PT Gamma Jaya", address: "Jl. Sudirman 1", contacts });
  });

  it("returns one client with projects, billing, ledger and history, never across workspaces", async () => {
    const ws = await workspace();
    const other = await workspace();
    const [c] = await db.insert(clients).values({ workspaceId: ws.id, name: "Acme" }).returning();
    const [foreign] = await db.insert(clients).values({ workspaceId: other.id, name: "Elsewhere" }).returning();
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "E", role: "R", model: "m" }).returning();
    const [p] = await db.insert(projects).values({ workspaceId: ws.id, clientId: c!.id, name: "Site", deadline: day(-2) }).returning();
    await db.insert(projects).values({ workspaceId: other.id, clientId: foreign!.id, name: "Not mine" });
    await db.insert(tasks).values({ workspaceId: ws.id, assigneeId: emp!.id, clientId: c!.id, projectId: p!.id, title: "Status report" });
    await db.insert(outboundEmails).values({ workspaceId: ws.id, clientId: c!.id, kind: "email", trigger: "approval", subject: "Weekly status", status: "sent", payload: {} });
    await db.insert(recurringBillings).values({ workspaceId: ws.id, clientId: c!.id, description: "Hosting", amount: 100 });
    await db.insert(invoices).values({ workspaceId: ws.id, clientId: c!.id, number: "INV-9", status: "sent", total: 111, dueDate: day(-1) });
    await signIn(ws.id, "VIEWER");
    const r = await callWithParams(getClient, "GET", `/api/clients/${c!.id}`, undefined, { id: c!.id });
    expect(r.status).toBe(200);
    expect(r.json.client).toMatchObject({ id: c!.id, outstanding: 111, overdue: 1, recurringMonthly: 100 });
    expect((r.json.projects as { name: string; health: string }[]).map((x) => [x.name, x.health])).toEqual([["Site", "late"]]);
    expect(r.json.recurring as unknown[]).toHaveLength(1);
    expect((r.json.invoices as { number: string; overdue: boolean }[])[0]).toMatchObject({ number: "INV-9", overdue: true });
    const h = r.json.history as { tasks: { title: string }[]; emails: { subject: string; status: string }[]; invoices: { number: string }[] };
    expect(h.tasks.map((x) => x.title)).toEqual(["Status report"]);
    expect(h.emails).toMatchObject([{ subject: "Weekly status", status: "sent" }]);
    expect(h.invoices.map((x) => x.number)).toEqual(["INV-9"]);
    const cross = await callWithParams(getClient, "GET", `/api/clients/${foreign!.id}`, undefined, { id: foreign!.id });
    expect(cross.status).toBe(404);
  });
});

describe("company profile API", () => {
  it("merges into workspace settings without touching other keys; only admins save", async () => {
    const ws = await workspace({ email: { paused: true, dailyLimit: 7 }, other: 1 });
    await signIn(ws.id, "MEMBER");
    const read = await call(getCompany, "GET", "/api/settings/company");
    expect(read.status).toBe(200);
    expect(read.json.company).toMatchObject({ invoicePrefix: "INV", defaultTaxPercent: 0 });
    expect((await call(putCompany, "PUT", "/api/settings/company", { legalName: "PT Kami" })).status).toBe(403);

    await signIn(ws.id, "ADMIN");
    const saved = await call(putCompany, "PUT", "/api/settings/company", { legalName: "PT Kami", taxId: "12.345", defaultTaxPercent: 11, invoicePrefix: "KM" });
    expect(saved.status).toBe(200);
    // a partial save keeps the fields it does not send
    const again = await call(putCompany, "PUT", "/api/settings/company", { bankName: "BCA" });
    expect(again.json.company).toMatchObject({ legalName: "PT Kami", bankName: "BCA", defaultTaxPercent: 11, invoicePrefix: "KM" });
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row!.settings).toMatchObject({ email: { paused: true, dailyLimit: 7 }, other: 1, company: { legalName: "PT Kami", bankName: "BCA" } });
    expect((await call(putCompany, "PUT", "/api/settings/company", { invoicePrefix: "bad prefix!" })).status).toBe(400);
  });
});

describe("recurring billings API", () => {
  it("validates workspace ownership, needs a month for yearly, and schedules the next run", async () => {
    const ws = await workspace();
    const other = await workspace();
    const [c] = await db.insert(clients).values({ workspaceId: ws.id, name: "Acme" }).returning();
    const [c2] = await db.insert(clients).values({ workspaceId: ws.id, name: "Beta" }).returning();
    const [p] = await db.insert(projects).values({ workspaceId: ws.id, clientId: c!.id, name: "Site" }).returning();
    const [p2] = await db.insert(projects).values({ workspaceId: ws.id, clientId: c2!.id, name: "Other client's" }).returning();
    const [emp] = await db.insert(employees).values({ workspaceId: ws.id, name: "Fin", role: "Finance", model: "m", specialty: "Invoices" }).returning();
    const [fc] = await db.insert(clients).values({ workspaceId: other.id, name: "Foreign" }).returning();
    const [fe] = await db.insert(employees).values({ workspaceId: other.id, name: "X", role: "R", model: "m" }).returning();
    const base = { clientId: c!.id, description: "Hosting", amount: 1_000_000, taxPercent: 11, dayOfMonth: 5 };

    await signIn(ws.id, "MEMBER");
    expect((await call(createRecurring, "POST", "/api/recurring-billings", base)).status).toBe(403);

    await signIn(ws.id, "ADMIN");
    expect((await call(createRecurring, "POST", "/api/recurring-billings", { ...base, clientId: fc!.id })).json.code).toBe("unknown_client");
    expect((await call(createRecurring, "POST", "/api/recurring-billings", { ...base, employeeId: fe!.id })).json.code).toBe("unknown_employee");
    expect((await call(createRecurring, "POST", "/api/recurring-billings", { ...base, projectId: p2!.id })).json.code).toBe("unknown_project");
    const yearlyNoMonth = await call(createRecurring, "POST", "/api/recurring-billings", { ...base, period: "yearly" });
    expect(yearlyNoMonth.status).toBe(400);

    const created = await call(createRecurring, "POST", "/api/recurring-billings", { ...base, projectId: p!.id, employeeId: emp!.id, recipients: ["fin@acme.test"] });
    expect(created.status).toBe(200);
    const r = created.json.recurring as { id: string; nextRunAt: string; period: string; startMonth: number | null };
    const next = new Date(r.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // 08:00 in Jakarta (UTC+7) on the 5th
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCDate()).toBe(5);

    // pausing keeps the schedule; a new period kind resets lastPeriod and moves the next run into that month
    await db.update(recurringBillings).set({ lastPeriod: "2026-10" }).where(eq(recurringBillings.id, r.id));
    const paused = await callWithParams(patchRecurring, "PATCH", `/api/recurring-billings/${r.id}`, { active: false }, { id: r.id });
    expect(paused.json.recurring).toMatchObject({ active: false, lastPeriod: "2026-10", nextRunAt: r.nextRunAt, description: "Hosting", taxPercent: 11 });
    expect((await callWithParams(patchRecurring, "PATCH", `/api/recurring-billings/${r.id}`, { period: "yearly" }, { id: r.id })).status).toBe(400);
    const yearly = await callWithParams(patchRecurring, "PATCH", `/api/recurring-billings/${r.id}`, { period: "yearly", startMonth: 3, active: true }, { id: r.id });
    expect(yearly.status).toBe(200);
    const y = yearly.json.recurring as { lastPeriod: string | null; nextRunAt: string; clientId: string };
    expect(y.lastPeriod).toBeNull();
    expect(new Date(y.nextRunAt).getUTCMonth()).toBe(2);
    expect(y.clientId).toBe(c!.id);
    // the client can't be moved by a patch, and a foreign employee is still refused
    expect((await callWithParams(patchRecurring, "PATCH", `/api/recurring-billings/${r.id}`, { employeeId: fe!.id }, { id: r.id })).json.code).toBe("unknown_employee");

    const list = await call(listRecurring, "GET", `/api/recurring-billings?clientId=${c!.id}`);
    expect((list.json.recurring as unknown[]).length).toBe(1);
    // a malformed clientId filter is a 400, not a database error
    const bad = await call(listRecurring, "GET", "/api/recurring-billings?clientId=not-a-uuid");
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("unknown_client");

    // another workspace's admin can neither change nor delete it
    await signIn(other.id, "ADMIN");
    expect((await callWithParams(patchRecurring, "PATCH", `/api/recurring-billings/${r.id}`, { amount: 1 }, { id: r.id })).status).toBe(404);
    expect((await callWithParams(deleteRecurring, "DELETE", `/api/recurring-billings/${r.id}`, undefined, { id: r.id })).status).toBe(404);
  });
});

describe("invoices API", () => {
  it("lets people mark paid, void and undo, with paidAt kept in step", async () => {
    const ws = await workspace();
    const [c] = await db.insert(clients).values({ workspaceId: ws.id, name: "Acme" }).returning();
    const [sent] = await db.insert(invoices).values({ workspaceId: ws.id, clientId: c!.id, number: "INV-2026-0001", status: "sent", sentAt: new Date(), total: 111, dueDate: day(3) }).returning();
    const [draft] = await db.insert(invoices).values({ workspaceId: ws.id, clientId: c!.id, number: "INV-2026-0002", status: "draft", total: 5 }).returning();
    await signIn(ws.id, "MEMBER");
    const patch = (id: string, status: string) => callWithParams(patchInvoice, "PATCH", `/api/invoices/${id}`, { status }, { id });

    queueModule.publish.mockClear();
    const paid = await patch(sent!.id, "paid");
    expect(paid.status).toBe(200);
    expect((paid.json.invoice as { paidAt: string | null }).paidAt).toBeTruthy();
    expect(queueModule.publish).toHaveBeenCalledWith(ws.id, { type: "invoice.updated", invoiceId: sent!.id, clientId: c!.id, status: "paid" });
    const back = await patch(sent!.id, "sent");
    expect(back.json.invoice).toMatchObject({ status: "sent", paidAt: null });
    expect((await patch(sent!.id, "void")).json.invoice).toMatchObject({ status: "void" });
    expect((await patch(sent!.id, "paid")).status).toBe(409);

    // a draft can be voided but not paid, and a never-sent void can't become "sent"
    expect((await patch(draft!.id, "paid")).json.code).toBe("invoice_transition");
    expect((await patch(draft!.id, "void")).status).toBe(200);
    expect((await patch(draft!.id, "sent")).status).toBe(409);
    expect((await patch(draft!.id, "draft")).status).toBe(409);

    const all = await call(listInvoices, "GET", `/api/invoices?clientId=${c!.id}`);
    expect((all.json.invoices as unknown[]).length).toBe(2);
    const bad = await call(listInvoices, "GET", "/api/invoices?clientId=1%27%20or%201=1");
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("unknown_client");
    const voided = await call(listInvoices, "GET", "/api/invoices?status=void");
    expect((voided.json.invoices as { client: { name: string } }[]).map((x) => x.client.name)).toEqual(["Acme", "Acme"]);

    // another workspace sees none of it
    const other = await workspace();
    await signIn(other.id, "ADMIN");
    expect((await patch(draft!.id, "void")).status).toBe(404);
  });

  it("downloads the ledger invoice as a PDF", async () => {
    const ws = await workspace({ company: { legalName: "PT Kami", defaultTaxPercent: 11 } });
    const [c] = await db.insert(clients).values({ workspaceId: ws.id, name: "Acme", legalName: "PT Acme", taxId: "99.1" }).returning();
    const [inv] = await db
      .insert(invoices)
      .values({ workspaceId: ws.id, clientId: c!.id, number: "INV/2026 0003", status: "draft", lines: line(1_000_000), subtotal: 1_000_000, taxPercent: 11, tax: 110_000, total: 1_110_000, dueDate: day(14) })
      .returning();
    await signIn(ws.id, "VIEWER");
    const req = new NextRequest(`http://localhost:3010/api/invoices/${inv!.id}/pdf`, { headers: { "x-real-ip": "203.0.113.7" } });
    const res = await invoicePdf(req, { params: Promise.resolve({ id: inv!.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="INV_2026_0003.pdf"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
