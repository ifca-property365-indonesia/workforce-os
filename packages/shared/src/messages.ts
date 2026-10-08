import { isLocale, type Locale } from "./index";

/**
 * Bilingual templates for text the worker produces outside the web UI: notifications (in-app, email,
 * webhook), default invoice emails and the invoice PDF. Values are substituted for {name} placeholders.
 */
const MESSAGES = {
  en: {
    "notify.approvalNeeded": "Approval needed: {title}",
    "notify.approvalNeededText": "{employee} ({role}) wants to run {tool}.\nReason: {reason}",
    "notify.taskFinished": "Task finished: {title}",
    "notify.taskFailed": "Task failed: {title}",
    "notify.pausedBudget": "{name} paused: budget cap",
    "notify.pausedMidTask": "{name} paused mid-task: budget cap",
    "notify.open": "Open: {url}",
    "invoice.subject": "Invoice {number}",
    "invoice.body": "Dear {client},\n\nPlease find attached invoice {number} for {total}, due {due}.\n\nThank you.",
    "invoice.client": "client",
    "pdf.invoice": "INVOICE",
    "pdf.draft": "DRAFT",
    "pdf.billTo": "Bill to",
    "pdf.due": "Due: {date}",
    "pdf.description": "Description",
    "pdf.qty": "Qty",
    "pdf.unitPrice": "Unit price",
    "pdf.amount": "Amount",
    "pdf.total": "Total",
    "pdf.notes": "Notes",
  },
  id: {
    "notify.approvalNeeded": "Perlu persetujuan: {title}",
    "notify.approvalNeededText": "{employee} ({role}) ingin menjalankan {tool}.\nAlasan: {reason}",
    "notify.taskFinished": "Tugas selesai: {title}",
    "notify.taskFailed": "Tugas gagal: {title}",
    "notify.pausedBudget": "{name} dijeda: batas anggaran",
    "notify.pausedMidTask": "{name} dijeda di tengah tugas: batas anggaran",
    "notify.open": "Buka: {url}",
    "invoice.subject": "Faktur {number}",
    "invoice.body": "Yth. {client},\n\nTerlampir faktur {number} sebesar {total}, jatuh tempo {due}.\n\nTerima kasih.",
    "invoice.client": "Bapak/Ibu",
    "pdf.invoice": "FAKTUR",
    "pdf.draft": "DRAF",
    "pdf.billTo": "Ditagihkan kepada",
    "pdf.due": "Jatuh tempo: {date}",
    "pdf.description": "Deskripsi",
    "pdf.qty": "Jml",
    "pdf.unitPrice": "Harga satuan",
    "pdf.amount": "Jumlah",
    "pdf.total": "Total",
    "pdf.notes": "Catatan",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)["en"];

export function msg(locale: string | null | undefined, key: MessageKey, values: Record<string, string | number> = {}): string {
  const l: Locale = isLocale(locale) ? locale : "en";
  return MESSAGES[l][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export const MESSAGE_CATALOG = MESSAGES;
