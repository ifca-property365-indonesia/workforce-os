-- Workflows (after OpenHuman's workflows): a saved sequence of steps (an employee's task, a condition, a person's
-- approval, a notice) that runs on a schedule or by hand. An employee may only propose one (a draft, off); a person
-- reviews it and turns it on. Each run keeps a snapshot of the steps and waits durably on tasks and approvals.
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "trigger" jsonb NOT NULL,
  "steps" jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "proposed_by_employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "untrusted_input" boolean DEFAULT false NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_ws" ON "workflows" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "steps" jsonb NOT NULL,
  "step_index" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "waiting_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "waiting_approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "untrusted" boolean DEFAULT false NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_workflow" ON "workflow_runs" ("workflow_id", "created_at");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workflow_run_id" uuid REFERENCES "workflow_runs"("id") ON DELETE SET NULL;
