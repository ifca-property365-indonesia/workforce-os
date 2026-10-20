-- P2: every change to an employee's configuration (instructions, tools, budget, skills…) is a numbered revision with a
-- full snapshot, to compare and roll back. Version 1 is the state before the first recorded change.
CREATE TABLE IF NOT EXISTS "employee_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  -- baseline | person | replay | hr_auto | skills | skill_install | rollback
  "source" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_label" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "restored_version" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_revisions_version" ON "employee_revisions" ("employee_id", "version");
