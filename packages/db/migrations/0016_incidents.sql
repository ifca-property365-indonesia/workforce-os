-- Incidents: a run failed, stalled, looped, could not start, or a routine failed. The team lead gets a turn to
-- retry/reassign (bounded), otherwise a person is notified.
CREATE TABLE IF NOT EXISTS "incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "parent_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "routine_id" uuid REFERENCES "routines"("id") ON DELETE SET NULL,
  "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "handler_employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "summary" text NOT NULL DEFAULT '',
  "resolution" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_ws_status" ON "incidents" ("workspace_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_task" ON "incidents" ("task_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;
