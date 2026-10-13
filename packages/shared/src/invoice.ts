import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { invoiceSubtotal, invoiceTax, invoiceTotal, parseCompanyProfile, type CompanyProfile, type InvoicePayload } from "./index";
import { msg } from "./messages";

export function formatMoney(n: number, currency: string, locale = "id-ID"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: currency === "IDR" ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** Client fields printed under "Bill to" (legal name falls back to the client's name). */
export interface InvoicePdfClient {
  legalName?: string;
  address?: string;
  taxId?: string;
}

export interface InvoicePdfMeta {
  workspaceName: string;
  clientName: string;
  clientEmail?: string;
  draft?: boolean;
  locale?: string | null;
  /** the workspace's company profile (workspaces.settings.company): legal name, address, tax id, bank, footer */
  company?: Partial<CompanyProfile> | null;
  client?: InvoicePdfClient | null;
}

/** The PDF meta for a workspace row and a client row, the same way the worker (email attachment) and the web (preview) build it. */
export function invoicePdfMeta(
  ws: { name: string; settings?: unknown; defaultLocale?: string | null } | null | undefined,
  client: { name: string; email?: string | null; legalName?: string | null; address?: string | null; taxId?: string | null } | null | undefined,
  draft: boolean,
): InvoicePdfMeta {
  return {
    workspaceName: ws?.name ?? "Workforce OS",
    clientName: client?.name ?? "Client",
    clientEmail: client?.email || undefined,
    draft,
    locale: ws?.defaultLocale ?? null,
    company: parseCompanyProfile(ws?.settings),
    client: client ? { legalName: client.legalName ?? "", address: client.address ?? "", taxId: client.taxId ?? "" } : null,
  };
}

/**
 * Text the standard (WinAnsi) fonts can draw: an unsupported character makes pdf-lib throw, so each one is replaced by
 * its plain base letter when it has one (ğ → g) or by "?"; tabs and line breaks become spaces.
 */
export function pdfSafeText(s: string, supported: ReadonlySet<number>): string {
  let out = "";
  for (const ch of s.replace(/[\t\r\n]+/g, " ")) {
    const cp = ch.codePointAt(0)!;
    if (supported.has(cp)) {
      out += ch;
      continue;
    }
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += base && [...base].every((c) => supported.has(c.codePointAt(0)!)) ? base : "?";
  }
  return out;
}

const PAGE: [number, number] = [595, 842];
const LEFT = 50;
const RIGHT = 545;
/** below this the next block starts a new page */
const BOTTOM = 90;

/** Render an invoice to PDF bytes (pure JS, no network). */
export async function renderInvoicePdf(inv: InvoicePayload, meta: InvoicePdfMeta): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(font.getCharacterSet());
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const company = meta.company ?? {};
  const numLocale = meta.locale === "en" ? "en-US" : "id-ID";
  const L = (k: Parameters<typeof msg>[1], v?: Record<string, string | number>) => msg(meta.locale, k, v);
  const money = (n: number) => formatMoney(n, inv.currency, numLocale);
  const safe = (s: string) => pdfSafeText(s, supported);

  let page: PDFPage = pdf.addPage(PAGE);
  let y = 790;
  const text = (s: string, x: number, size = 10, f: PDFFont = font, color = ink) => page.drawText(safe(s), { x, y, size, font: f, color });
  /** right-aligned at `right` */
  const textR = (s: string, right: number, size = 10, f: PDFFont = font, color = ink) => {
    const t = safe(s);
    page.drawText(t, { x: right - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  /** shortened with "…" to fit `width` */
  const fit = (s: string, width: number, size = 10, f: PDFFont = font) => {
    let t = safe(s);
    if (f.widthOfTextAtSize(t, size) <= width) return t;
    t = t.slice(0, 400);
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };
  const lines = (s: string | undefined, max: number) =>
    (s ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, max);
  const newPageIfBelow = (min: number) => {
    if (y >= min) return;
    page = pdf.addPage(PAGE);
    y = 790;
  };

  if (meta.draft) {
    page.drawText(safe(L("pdf.draft")), { x: 380, y: 740, size: 48, font: bold, color: rgb(0.9, 0.3, 0.3), opacity: 0.25 });
  }

  // ---- header: the issuing company (left), invoice number and due date (right) ----
  const top = y;
  text(fit(company.legalName || meta.workspaceName, 300, 16, bold), LEFT, 16, bold);
  textR(L("pdf.invoice"), RIGHT, 16, bold);
  y -= 16;
  textR(inv.invoiceNumber, RIGHT, 10, font, muted);
  y -= 14;
  textR(L("pdf.due", { date: inv.dueDate }), RIGHT, 10, font, muted);
  y = top - 18;
  for (const l of lines(company.address, 3)) {
    text(fit(l, 300, 9), LEFT, 9, font, muted);
    y -= 12;
  }
  if (company.taxId) {
    text(fit(L("pdf.taxId", { id: company.taxId }), 300, 9), LEFT, 9, font, muted);
    y -= 12;
  }
  const contact = [company.phone, company.email].filter(Boolean).join(" · ");
  if (contact) {
    text(fit(contact, 300, 9), LEFT, 9, font, muted);
    y -= 12;
  }
  y = Math.min(y, top - 44) - 20;

  // ---- bill to ----
  text(L("pdf.billTo"), LEFT, 9, font, muted);
  y -= 14;
  text(fit(meta.client?.legalName || meta.clientName, 400, 11, bold), LEFT, 11, bold);
  for (const l of lines(meta.client?.address, 3)) {
    y -= 13;
    text(fit(l, 400), LEFT);
  }
  if (meta.client?.taxId) {
    y -= 13;
    text(fit(L("pdf.taxId", { id: meta.client.taxId }), 400), LEFT);
  }
  if (meta.clientEmail) {
    y -= 13;
    text(fit(meta.clientEmail, 400), LEFT);
  }
  y -= 36;

  // ---- lines ----
  const header = () => {
    text(L("pdf.description"), LEFT, 9, bold, muted);
    textR(L("pdf.qty"), 345, 9, bold, muted);
    textR(L("pdf.unitPrice"), 445, 9, bold, muted);
    textR(L("pdf.amount"), RIGHT, 9, bold, muted);
    y -= 8;
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.5, color: muted });
    y -= 16;
  };
  header();
  for (const l of inv.lines) {
    if (y < BOTTOM + 20) {
      newPageIfBelow(BOTTOM + 20);
      header(); // repeated on the new page
    }
    text(fit(l.description, 260), LEFT);
    textR(new Intl.NumberFormat(numLocale, { maximumFractionDigits: 2 }).format(l.quantity), 345);
    textR(money(l.unitPrice), 445);
    textR(money(l.quantity * l.unitPrice), RIGHT);
    y -= 18;
  }

  // ---- totals ----
  newPageIfBelow(BOTTOM + 60);
  page.drawLine({ start: { x: 330, y: y + 6 }, end: { x: RIGHT, y: y + 6 }, thickness: 0.5, color: muted });
  y -= 10;
  const taxPercent = inv.taxPercent ?? 0;
  if (taxPercent > 0) {
    text(L("pdf.subtotal"), 345);
    textR(money(invoiceSubtotal(inv)), RIGHT);
    y -= 16;
    text(L("pdf.tax", { percent: new Intl.NumberFormat(numLocale, { maximumFractionDigits: 2 }).format(taxPercent) }), 345);
    textR(money(invoiceTax(inv)), RIGHT);
    y -= 18;
  }
  text(L("pdf.total"), 345, 11, bold);
  textR(money(invoiceTotal(inv)), RIGHT, 11, bold);

  if (inv.notes) {
    y -= 40;
    newPageIfBelow(BOTTOM + 30);
    text(L("pdf.notes"), LEFT, 9, bold, muted);
    y -= 14;
    for (const line of inv.notes.split("\n").slice(0, 6)) {
      text(fit(line, RIGHT - LEFT, 9), LEFT, 9);
      y -= 12;
    }
  }

  // ---- footer: how to pay, then the company's own footer text ----
  const footer: string[] = [];
  if (company.bankName || company.bankAccount) footer.push(L("pdf.bank", { bank: company.bankName ?? "", account: company.bankAccount ?? "" }).replace(/\s+/g, " ").trim());
  if (company.bankHolder) footer.push(L("pdf.bankHolder", { holder: company.bankHolder }));
  footer.push(...lines(company.invoiceFooter, 4));
  if (footer.length) {
    y -= 30;
    newPageIfBelow(BOTTOM);
    page.drawLine({ start: { x: LEFT, y: y + 12 }, end: { x: RIGHT, y: y + 12 }, thickness: 0.5, color: muted });
    for (const f of footer) {
      text(fit(f, RIGHT - LEFT, 9), LEFT, 9, font, muted);
      y -= 12;
    }
  }
  return pdf.save();
}
