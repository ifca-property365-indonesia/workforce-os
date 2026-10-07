import nodemailer from "nodemailer";
import { withRetry } from "./server";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromAddress: string;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function sendMail(cfg: SmtpConfig, mail: OutgoingMail): Promise<{ messageId: string; accepted: string[] }> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    const info = await withRetry(
      async () =>
        transport.sendMail({
          from: cfg.fromAddress,
          to: mail.to.join(", "),
          cc: mail.cc?.length ? mail.cc.join(", ") : undefined,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments: mail.attachments,
        }),
      { retries: 2, timeoutMs: 30000, label: "smtp" },
    );
    return { messageId: String(info.messageId), accepted: (info.accepted as unknown[]).map(String) };
  } finally {
    transport.close();
  }
}
