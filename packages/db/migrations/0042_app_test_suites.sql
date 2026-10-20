-- A full test of an app: its modules split into packages, each tested in its own session of the same tester, one
-- after the other. app_tests rows of a suite start "queued" and become "cancelled" when the suite is stopped.
CREATE TABLE IF NOT EXISTS "app_test_suites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "environment_id" uuid NOT NULL REFERENCES "app_environments"("id") ON DELETE CASCADE,
  "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  -- running | done | stopped
  "status" text DEFAULT 'running' NOT NULL,
  "focus" text DEFAULT '' NOT NULL,
  "roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_test_suites_app" ON "app_test_suites" ("app_id", "created_at");
--> statement-breakpoint
ALTER TABLE "app_tests" ADD COLUMN IF NOT EXISTS "suite_id" uuid REFERENCES "app_test_suites"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "app_tests" ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_tests" ADD COLUMN IF NOT EXISTS "title" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_tests" ADD COLUMN IF NOT EXISTS "module_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_tests_suite" ON "app_tests" ("suite_id", "position");
