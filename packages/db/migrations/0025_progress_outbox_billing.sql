-- Task progress reported by the assignee, an outbox of emails sent on an employee's behalf, and deeper client
-- master data: client profile fields, recurring billing and an invoice ledger.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "progress" integer;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "progress_note" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "progress_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "legal_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "tax_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "address" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "phone" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbound_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text DEFAULT 'sending' NOT NULL,
  "trigger" text NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "client_id" uuid REFERENCES "clients"("id") ON DELETE SET NULL,
  "to" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subject" text DEFAULT '' NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "payload" jsonb NOT NULL,
  "error" text,
  "message_id" text,
  "resend_of" uuid REFERENCES "outbound_emails"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_emails_ws_created" ON "outbound_emails" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_emails_client" ON "outbound_emails" ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_billings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "description" text NOT NULL,
  "amount" double precision NOT NULL,
  "tax_percent" double precision DEFAULT 0 NOT NULL,
  "due_days" integer DEFAULT 14 NOT NULL,
  "period" text DEFAULT 'monthly' NOT NULL,
  "day_of_month" integer DEFAULT 1 NOT NULL,
  "start_month" integer,
  "active" boolean DEFAULT true NOT NULL,
  "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_period" text,
  "next_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_billings_due" ON "recurring_billings" ("active", "next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_billings_client" ON "recurring_billings" ("client_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "number" text NOT NULL,
  "currency" text DEFAULT 'IDR' NOT NULL,
  "lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subtotal" double precision DEFAULT 0 NOT NULL,
  "tax_percent" double precision DEFAULT 0 NOT NULL,
  "tax" double precision DEFAULT 0 NOT NULL,
  "total" double precision DEFAULT 0 NOT NULL,
  "due_date" date,
  "notes" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "period" text,
  "recurring_id" uuid REFERENCES "recurring_billings"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "email_id" uuid REFERENCES "outbound_emails"("id") ON DELETE SET NULL,
  "sent_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_ws_number" ON "invoices" ("workspace_id", "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_client" ON "invoices" ("client_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_recurring_period" ON "invoices" ("recurring_id", "period");
