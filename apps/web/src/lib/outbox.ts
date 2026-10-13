import type { OutboundEmailKind, OutboundEmailTrigger, OutboxStatus } from "@wfos/shared";

/** One line of the outbox: an attempt from outbound_emails, or a proposal still (or no longer) waiting in approvals. */
export interface OutboxItem {
  /** outbound_emails id, or "approval:<approval id>" */
  id: string;
  source: "email" | "approval";
  approvalId: string | null;
  kind: OutboundEmailKind;
  status: OutboxStatus;
  trigger: OutboundEmailTrigger | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** size 0 = not known yet (an invoice PDF is rendered when it is sent) */
  attachments: { filename: string; size: number }[];
  error: string | null;
  employee: { id: string; name: string } | null;
  taskId: string | null;
  client: { id: string; name: string } | null;
  /** every to/cc address checked against the client master; known:false = not on any client's file */
  recipients: { email: string; known: boolean; contactName?: string; role?: string }[];
  createdAt: string;
  sentAt: string | null;
  resendOf: string | null;
  /** the newer attempt that resent this one (a failed email can be resent once); null = not resent */
  resentAs: string | null;
}

export interface OutboxStats {
  sentToday: number;
  failedToday: number;
  /** email proposals waiting for a decision */
  pending: number;
  dailyLimit: number;
  paused: boolean;
}

export const OUTBOX_STATUSES = ["pending_approval", "rejected", "expired", "sending", "sent", "failed"] as const satisfies readonly OutboxStatus[];
