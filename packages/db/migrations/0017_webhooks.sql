-- Inbound webhook triggers: an external system POSTs to /api/hooks/<id> with a bearer secret and a task is
-- created for an employee or a team. The payload is untrusted: the task starts tainted.
CREATE TABLE IF NOT EXISTS "webhook_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "secret_hash" text NOT NULL,
  "assignee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "brief_template" text NOT NULL DEFAULT '',
  "dry_run" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_fired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_triggers_ws" ON "webhook_triggers" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger_id" uuid NOT NULL REFERENCES "webhook_triggers"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "idempotency_key" text,
  "status" text NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "error" text,
  "payload_excerpt" text NOT NULL DEFAULT '',
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_idem" ON "webhook_deliveries" ("trigger_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_trigger" ON "webhook_deliveries" ("trigger_id", "received_at");
--> statement-breakpoint
-- A task created from untrusted input (webhook payload) starts its run tainted: no irreversible action runs unattended.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "untrusted_input" boolean NOT NULL DEFAULT false;
