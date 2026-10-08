import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { invoiceTotal, type InvoicePayload } from "./index";
import { msg } from "./messages";

export function formatMoney(n: number, currency: string, locale = "id-ID"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: currency === "IDR" ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** Render an invoice to PDF bytes (pure JS, no network). */
export async function renderInvoicePdf(
  inv: InvoicePayload,
  meta: { workspaceName: string; clientName: string; clientEmail?: string; draft?: boolean; locale?: string | null },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(s, { x, y, size, font: f, color });
  const L = (k: Parameters<typeof msg>[1], v?: Record<string, string | number>) => msg(meta.locale, k, v);
  const money = (n: number) => formatMoney(n, inv.currency, meta.locale === "en" ? "en-US" : "id-ID");

  if (meta.draft) {
    page.drawText(L("pdf.draft"), { x: 380, y: 760, size: 48, font: bold, color: rgb(0.9, 0.3, 0.3), opacity: 0.25 });
  }
  text(meta.workspaceName, 50, 16, bold);
  text(L("pdf.invoice"), 430, 16, bold);
  y -= 22;
  text(inv.invoiceNumber, 430, 10, font, muted);
  y -= 30;
  text(L("pdf.billTo"), 50, 9, font, muted);
  y -= 14;
  text(meta.clientName, 50, 11, bold);
  if (meta.clientEmail) {
    y -= 14;
    text(meta.clientEmail, 50, 10);
  }
  y -= 14;
  text(L("pdf.due", { date: inv.dueDate }), 50, 10);
  y -= 36;
  text(L("pdf.description"), 50, 9, bold, muted);
  text(L("pdf.qty"), 330, 9, bold, muted);
  text(L("pdf.unitPrice"), 380, 9, bold, muted);
  text(L("pdf.amount"), 480, 9, bold, muted);
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: muted });
  y -= 16;
  for (const l of inv.lines) {
    const desc = l.description.length > 52 ? `${l.description.slice(0, 50)}…` : l.description;
    text(desc, 50);
    text(String(l.quantity), 330);
    text(money(l.unitPrice), 380);
    text(money(l.quantity * l.unitPrice), 480);
    y -= 18;
    if (y < 120) break;
  }
  page.drawLine({ start: { x: 330, y: y + 6 }, end: { x: 545, y: y + 6 }, thickness: 0.5, color: muted });
  y -= 10;
  text(L("pdf.total"), 380, 11, bold);
  text(money(invoiceTotal(inv)), 480, 11, bold);
  if (inv.notes) {
    y -= 40;
    text(L("pdf.notes"), 50, 9, bold, muted);
    y -= 14;
    for (const line of inv.notes.split("\n").slice(0, 6)) {
      text(line.slice(0, 95), 50, 9);
      y -= 12;
    }
  }
  return pdf.save();
}
