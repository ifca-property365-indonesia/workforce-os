import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { approvals, clients, db, invoices, outboundEmails, projects, users } from "@wfos/db";
import { invoicePayloadSchema, type InvoicePayload, type RealtimeEvent } from "@wfos/shared";
import { invoicePdfMeta, renderInvoicePdf } from "@wfos/shared/invoice";
import { executeApproval } from "../src/runner/approvals";
import { buildTools, type RunContext } from "../src/tools/registry";
import { insertWithNextNumber, localYear, nextInvoiceNumber } from "../src/lib/invoices";
import { resendOutbound } from "../src/lib/outbox";
import { makeEmployee, makeTask, makeWorkspace, runContext } from "./fixtures";
import { resetTransport, transport } from "./transport";

beforeEach(() => resetTransport());

const textOf = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

const events = () => transport.published.map((p) => p.ev as RealtimeEvent);
const year = localYear("Asia/Jakarta");
const company = { legalName: "PT Vardiv Studio Kreatif", address: "Jl. Kemang Raya 10\nJakarta Selatan", taxId: "01.234.567.8-901.000", bankName: "BCA", bankAccount: "1234567890", bankHolder: "PT Vardiv Studio Kreatif", invoicePrefix: "VDV", invoiceFooter: "Terima kasih atas kepercayaan Anda.", defaultTaxPercent: 11 };

async function setup(over: { autonomyLevel?: "QUEUE" | "CLOSE"; allowList?: RunContext["employee"]["allowList"] } = {}) {
  const ws = await makeWorkspace({ settings: { company }, defaultLocale: "id" });
  const emp = await makeEmployee(ws.id, {
    autonomyLevel: over.autonomyLevel ?? "QUEUE",
    allowList: over.allowList,
    toolPermissions: ["draft_invoice", "send_invoice", "send_email", "list_invoices", "get_client", "list_clients"].map((tool) => ({ tool, enabled: true })),
  });
  const [client] = await db
    .insert(clients)
    .values({
      workspaceId: ws.id,
      name: "Sinar Logistik",
      email: "ops@sinar.co.id",
      currency: "IDR",
      legalName: "PT Sinar Logistik Nusantara",
      taxId: "02.345.678.9-012.000",
      address: "Jl. Gatot Subroto 5, Jakarta",
      contacts: [
        { name: "Budi", email: "budi@sinar.co.id", role: "director" }, // pre-0025 shape: no receives
        { name: "Rina", email: "finance@sinar.co.id", role: "billing", phone: "+62 811", receives: { status: false, minutes: false, invoice: true } },
      ],
    })
    .returning();
  const task = await makeTask(ws.id, emp.id, { status: "RUNNING" });
  const ctx = runContext(ws, emp, task.id);
  const call = (name: string, args: Record<string, unknown>) => buildTools(ctx).find((d) => d.name === name)!.handler(args, {});
  return { ws, emp, client: client!, task, ctx, call };
}

const lines = [{ description: "Fleet dashboard — Oktober", quantity: 10, unitPrice: 1_000_000 }];
const ledger = (workspaceId: string) => db.select().from(invoices).where(eq(invoices.workspaceId, workspaceId));

describe("invoice ledger", () => {
  it("draft_invoice records a draft (company default tax, client currency) and updates it when drafted again", async () => {
    const { ws, client, task, call } = await setup();
    const r = await call("draft_invoice", { clientId: client.id, invoiceNumber: `VDV-${year}-0001`, lines, dueDate: "2026-11-30" });
    expect(r.isError).toBeFalsy();
    let [row] = await ledger(ws.id);
    expect(row).toMatchObject({ number: `VDV-${year}-0001`, status: "draft", currency: "IDR", taxPercent: 11, subtotal: 10_000_000, tax: 1_100_000, total: 11_100_000, dueDate: "2026-11-30", taskId: task.id });
    expect(events()).toContainEqual({ type: "invoice.updated", invoiceId: row!.id, clientId: client.id, status: "draft" });

    await call("draft_invoice", { clientId: client.id, invoiceNumber: `VDV-${year}-0001`, lines: [{ description: "Fixed", quantity: 1, unitPrice: 500 }], taxPercent: 0, dueDate: "2026-12-15" });
    const all = await ledger(ws.id);
    expect(all).toHaveLength(1);
    [row] = all;
    expect(row).toMatchObject({ status: "draft", total: 500, taxPercent: 0, dueDate: "2026-12-15" });
  });

  it("a number already sent, paid or void is refused by draft_invoice and by send_invoice at proposal time", async () => {
    const { ws, client, call } = await setup();
    await db.insert(invoices).values({ workspaceId: ws.id, clientId: client.id, number: "VDV-OLD-1", status: "paid" });
    const d = await call("draft_invoice", { clientId: client.id, invoiceNumber: "VDV-OLD-1", lines, dueDate: "2026-11-30" });
    expect(d.isError).toBe(true);
    expect(textOf(d)).toMatch(/Invoice number VDV-OLD-1 is already used \(status paid\); pick the next number/);
    const s = await call("send_invoice", { clientId: client.id, invoiceNumber: "VDV-OLD-1", lines, dueDate: "2026-11-30" });
    expect(s.isError).toBe(true);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(0);
    // a client of another workspace is not found
    const other = await makeWorkspace();
    const [foreign] = await db.insert(clients).values({ workspaceId: other.id, name: "Other" }).returning();
    expect((await call("draft_invoice", { clientId: foreign!.id, invoiceNumber: "X-1", lines, dueDate: "2026-11-30" })).isError).toBe(true);
  });

  it("send_invoice: empty `to` → invoice contacts; once executed the ledger row is sent with email, approval and task", async () => {
    const { ws, client, task, call } = await setup();
    const number = `VDV-${year}-0002`;
    await call("draft_invoice", { clientId: client.id, invoiceNumber: number, lines, dueDate: "2026-11-30" });
    const r = await call("send_invoice", { clientId: client.id, invoiceNumber: number, lines, dueDate: "2026-11-30" });
    expect(textOf(r)).toMatch(/Queued for human approval/);
    const [a] = await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id));
    expect(a!.payload).toMatchObject({ to: ["finance@sinar.co.id"], taxPercent: 11, currency: "IDR" });

    await db.update(approvals).set({ status: "APPROVED" }).where(eq(approvals.id, a!.id));
    await executeApproval(a!.id);
    expect(transport.mails).toHaveLength(1);
    const mail = transport.mails[0]!.mail;
    expect(mail.to).toEqual(["finance@sinar.co.id"]);
    expect(mail.subject).toBe(`Faktur ${number}`);
    expect(mail.attachments?.[0]).toMatchObject({ filename: `${number}.pdf`, contentType: "application/pdf" });

    const [email] = await db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, ws.id));
    expect(email).toMatchObject({ kind: "invoice", status: "sent", clientId: client.id, subject: `Faktur ${number}`, attachments: [expect.objectContaining({ filename: `${number}.pdf` })] });
    const rows = await ledger(ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", emailId: email!.id, approvalId: a!.id, taskId: task.id, total: 11_100_000 });
    expect(rows[0]!.sentAt).toBeInstanceOf(Date);
    expect(events()).toContainEqual({ type: "invoice.updated", invoiceId: rows[0]!.id, clientId: client.id, status: "sent" });
  });

  it("an executed send for a number already sent elsewhere is refused and logged as failed", async () => {
    const { ws, emp, client } = await setup();
    await db.insert(invoices).values({ workspaceId: ws.id, clientId: client.id, number: "VDV-DUP", status: "sent" });
    const payload = invoicePayloadSchema.parse({ clientId: client.id, invoiceNumber: "VDV-DUP", lines, dueDate: "2026-11-30", to: ["ops@sinar.co.id"] });
    const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_invoice", title: "Invoice", payload, status: "APPROVED" }).returning();
    await executeApproval(a!.id);
    expect(transport.mails).toHaveLength(0);
    const [email] = await db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, ws.id));
    expect(email).toMatchObject({ status: "failed", error: expect.stringMatching(/already used \(status sent\)/) });
  });

  it("a voided or paid ledger invoice is never emailed, by its approval or by a resend", async () => {
    const { ws, emp, client } = await setup();
    for (const status of ["void", "paid"] as const) {
      const number = `VDV-${status.toUpperCase()}`;
      const [row] = await db.insert(invoices).values({ workspaceId: ws.id, clientId: client.id, number, status: "draft" }).returning();
      const payload = invoicePayloadSchema.parse({ clientId: client.id, invoiceNumber: number, lines, dueDate: "2026-11-30", to: ["ops@sinar.co.id"], invoiceId: row!.id });
      const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_invoice", title: "Invoice", payload, status: "APPROVED" }).returning();
      // voided (or paid) while the approval waited
      await db.update(invoices).set({ status }).where(eq(invoices.id, row!.id));
      await executeApproval(a!.id);
      const [email] = await db.select().from(outboundEmails).where(eq(outboundEmails.approvalId, a!.id));
      expect(email).toMatchObject({ status: "failed", error: `Invoice ${number} is ${status}; not sent.` });
      expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("FAILED");
      const [u] = await db.insert(users).values({ email: `r-${status}-${ws.id.slice(0, 8)}@test.local`, name: "O", passwordHash: "x" }).returning();
      const again = await resendOutbound(email!.id, ws.id, u!.id);
      expect(again).toMatchObject({ ok: false, summary: `Invoice ${number} is ${status}; not sent.` });
      expect((await db.select().from(invoices).where(eq(invoices.id, row!.id)))[0]!.status).toBe(status);
    }
    expect(transport.mails).toHaveLength(0);
  });

  it("the recurring draft (or an already sent row) is still exempt from the duplicate check", async () => {
    const { ws, emp, client } = await setup();
    const [row] = await db.insert(invoices).values({ workspaceId: ws.id, clientId: client.id, number: "VDV-OWN", status: "sent" }).returning();
    const payload = invoicePayloadSchema.parse({ clientId: client.id, invoiceNumber: "VDV-OWN", lines, dueDate: "2026-11-30", to: ["ops@sinar.co.id"], invoiceId: row!.id });
    const [a] = await db.insert(approvals).values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_invoice", title: "Invoice", payload, status: "APPROVED" }).returning();
    await executeApproval(a!.id);
    expect(transport.mails).toHaveLength(1);
  });

  it("next number: 1 + the highest sequence for the prefix and local year; concurrent inserts never collide", async () => {
    const { ws, client } = await setup();
    expect(await nextInvoiceNumber(ws.id)).toBe(`VDV-${year}-0001`);
    await db.insert(invoices).values([
      { workspaceId: ws.id, clientId: client.id, number: `VDV-${year}-0003` },
      { workspaceId: ws.id, clientId: client.id, number: `VDV-${year}-0010` },
      { workspaceId: ws.id, clientId: client.id, number: `VDV-${year - 1}-0042` },
      { workspaceId: ws.id, clientId: client.id, number: `VDV-${year}-0099-draft` },
      { workspaceId: ws.id, clientId: client.id, number: "INV-0500" },
    ]);
    expect(await nextInvoiceNumber(ws.id)).toBe(`VDV-${year}-0011`);
    const made = await Promise.all(Array.from({ length: 3 }, () => insertWithNextNumber(db, ws.id, { clientId: client.id, status: "draft" })));
    expect(made.map((m) => m!.number).sort()).toEqual([`VDV-${year}-0011`, `VDV-${year}-0012`, `VDV-${year}-0013`]);
  });

  it("list_invoices returns the company numbering and the ledger; get_client returns parsed contacts and the new fields", async () => {
    const { ws, client, call } = await setup();
    await db.insert(invoices).values({ workspaceId: ws.id, clientId: client.id, number: `VDV-${year}-0004`, status: "sent", total: 111, currency: "IDR", dueDate: "2026-11-01" });
    const list = JSON.parse(textOf(await call("list_invoices", { status: "sent" })));
    expect(list.company).toEqual({ invoicePrefix: "VDV", defaultTaxPercent: 11, nextNumber: `VDV-${year}-0005` });
    expect(list.invoices).toEqual([{ number: `VDV-${year}-0004`, clientId: client.id, total: 111, currency: "IDR", status: "sent", dueDate: "2026-11-01", sentAt: null, paidAt: null }]);

    const c = JSON.parse(textOf(await call("get_client", { clientId: client.id })));
    expect(c).toMatchObject({ status: "active", legalName: "PT Sinar Logistik Nusantara", taxId: "02.345.678.9-012.000", address: "Jl. Gatot Subroto 5, Jakarta" });
    expect(c.contacts[0]).toEqual({ name: "Budi", email: "budi@sinar.co.id", role: "director", phone: "", receives: { status: false, minutes: false, invoice: false } });
    expect(c.contacts[1].receives.invoice).toBe(true);
    const all = JSON.parse(textOf(await call("list_clients", {})));
    expect(all[0]).toMatchObject({ id: client.id, status: "active" });
  });

  it("projectId must belong to the client", async () => {
    const { ws, client, call } = await setup();
    const [p] = await db.insert(projects).values({ workspaceId: ws.id, clientId: client.id, name: "Fleet" }).returning();
    const ok = await call("draft_invoice", { clientId: client.id, invoiceNumber: "VDV-P-1", lines, dueDate: "2026-11-30", projectId: p!.id });
    expect(ok.isError).toBeFalsy();
    expect((await db.select().from(invoices).where(and(eq(invoices.workspaceId, ws.id), eq(invoices.number, "VDV-P-1"))))[0]!.projectId).toBe(p!.id);
    const [other] = await db.insert(clients).values({ workspaceId: ws.id, name: "Other" }).returning();
    const bad = await call("draft_invoice", { clientId: other!.id, invoiceNumber: "VDV-P-2", lines, dueDate: "2026-11-30", projectId: p!.id });
    expect(bad.isError).toBe(true);
  });
});

describe("allow-list: clientContactsOnly through the real gate", () => {
  const rule = { tool: "send_email", recipientDomains: [], clientIds: [], clientContactsOnly: true };

  it("an address on the client's file runs unattended; any other address needs approval", async () => {
    const { ws, client, call } = await setup({ autonomyLevel: "CLOSE", allowList: [rule] });
    await call("send_email", { to: ["Budi <BUDI@sinar.co.id>"], subject: "Status", body: "Weekly.", clientId: client.id });
    expect(transport.mails).toHaveLength(1);

    await call("send_email", { to: ["budi@sinar.co.id", "stranger@gmail.com"], subject: "Status", body: "Weekly.", clientId: client.id });
    // without a clientId nothing is "on file"
    await call("send_email", { to: ["budi@sinar.co.id"], subject: "Status", body: "Weekly." });
    expect(transport.mails).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(2);
  });

  it("a client of another workspace never makes its contacts known", async () => {
    const { ws, call } = await setup({ autonomyLevel: "CLOSE", allowList: [rule] });
    const other = await makeWorkspace();
    const [foreign] = await db.insert(clients).values({ workspaceId: other.id, name: "Other", email: "boss@other.co.id" }).returning();
    await call("send_email", { to: ["boss@other.co.id"], subject: "Hi", body: "Hi", clientId: foreign!.id });
    expect(transport.mails).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(1);
  });

  it("a multi-address recipient string is refused as a tool error and never mailed", async () => {
    const { ws, client, call } = await setup({ autonomyLevel: "CLOSE", allowList: [rule, { tool: "send_email", recipientDomains: ["sinar.co.id"], clientIds: [] }] });
    const r = await call("send_email", { to: ["evil@x.com, <budi@sinar.co.id>"], subject: "Status", body: "Weekly.", clientId: client.id });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid email: to\.0: Each recipient must be a single email address/);
    const inv = await call("send_invoice", { clientId: client.id, invoiceNumber: `VDV-${year}-0008`, lines, dueDate: "2026-11-30", to: ["evil@x.com; finance@sinar.co.id"] });
    expect(inv.isError).toBe(true);
    expect(textOf(inv)).toMatch(/Invalid invoice: to\.0/);
    expect(transport.mails).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.workspaceId, ws.id))).toHaveLength(0);
    expect(await db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, ws.id))).toHaveLength(0);
  });

  it("a stored approval with a multi-address recipient fails at execution without mailing", async () => {
    const { ws, emp } = await setup();
    const [a] = await db
      .insert(approvals)
      .values({ workspaceId: ws.id, employeeId: emp.id, toolName: "send_email", title: "Email", payload: { to: ["evil@x.com, <ok@sinar.co.id>"], subject: "s", body: "b" }, status: "APPROVED" })
      .returning();
    await executeApproval(a!.id);
    expect(transport.mails).toHaveLength(0);
    expect((await db.select().from(approvals).where(eq(approvals.id, a!.id)))[0]!.status).toBe("FAILED");
  });

  it("send_invoice uses the client's addresses too (an invoice contact runs unattended)", async () => {
    const { ws, client, call } = await setup({ autonomyLevel: "CLOSE", allowList: [{ ...rule, tool: "send_invoice" }] });
    await call("send_invoice", { clientId: client.id, invoiceNumber: `VDV-${year}-0007`, lines, dueDate: "2026-11-30" });
    expect(transport.mails).toHaveLength(1);
    const [row] = await ledger(ws.id);
    expect(row).toMatchObject({ status: "sent", approvalId: null });
    const [email] = await db.select().from(outboundEmails).where(eq(outboundEmails.workspaceId, ws.id));
    expect(email).toMatchObject({ trigger: "allow_list", kind: "invoice", status: "sent" });
  });
});

describe("invoice PDF", () => {
  async function text(pdf: Uint8Array): Promise<string> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: pdf });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }

  const inv: InvoicePayload = invoicePayloadSchema.parse({
    clientId: "c",
    invoiceNumber: "VDV-2026-0001",
    currency: "IDR",
    lines: [
      { description: "Pengembangan aplikasi — fase 2 (Oktober) 🚀 → ≥ 10 jam", quantity: 10, unitPrice: 1_000_000 },
      { description: "Konsultasi teknis untuk tim ğüş é ü — dengan deskripsi yang sangat panjang sekali sampai harus dipotong agar muat", quantity: 1.5, unitPrice: 250_000 },
    ],
    taxPercent: 11,
    dueDate: "2026-11-30",
    notes: "Mohon transfer sebelum jatuh tempo.\nTerima kasih 🙏",
  });

  it("prints the company profile, the client's legal details, subtotal / PPN / total and the bank footer, in Indonesian", async () => {
    const meta = invoicePdfMeta(
      { name: "Vardiv", settings: { company }, defaultLocale: "id" },
      { name: "Sinar", email: "ops@sinar.co.id", legalName: "PT Sinar Logistik Nusantara", address: "Jl. Gatot Subroto 5\nJakarta", taxId: "02.345.678.9-012.000" },
      true,
    );
    const pdf = await renderInvoicePdf(inv, meta);
    const t = await text(pdf);
    for (const s of ["PT Vardiv Studio Kreatif", "Jl. Kemang Raya 10", "NPWP: 01.234.567.8-901.000", "FAKTUR", "VDV-2026-0001", "PT Sinar Logistik Nusantara", "NPWP: 02.345.678.9-012.000", "Subtotal", "PPN 11%", "Transfer ke: BCA 1234567890", "Atas nama: PT Vardiv Studio Kreatif", "Terima kasih atas kepercayaan Anda."]) {
      expect(t).toContain(s);
    }
    // 10.375.000 + 11% (1.141.250) = 11.516.250
    expect(t.replace(/\s/g, "")).toContain("Rp11.516.250");
    expect(t).toMatch(/ğüş|güs/);
  });

  it("English labels, no tax line without tax, and the workspace name when there is no company profile", async () => {
    const pdf = await renderInvoicePdf({ ...inv, taxPercent: 0 }, invoicePdfMeta({ name: "Vardiv", settings: {}, defaultLocale: "en" }, { name: "Sinar" }, false));
    const t = await text(pdf);
    expect(t).toContain("Vardiv");
    expect(t).toContain("INVOICE");
    expect(t).not.toContain("Tax 0%");
    expect(t).not.toContain("Subtotal");
  });

  it("many lines continue on a new page", async () => {
    const many = { ...inv, lines: Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i + 1}`, quantity: 1, unitPrice: 1000 })) };
    const pdf = await renderInvoicePdf(many, invoicePdfMeta({ name: "Vardiv", settings: { company } }, { name: "Sinar" }, false));
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
    expect(await text(pdf)).toContain("Item 60"); // pdf-parse takes the buffer over: last
  });
});
