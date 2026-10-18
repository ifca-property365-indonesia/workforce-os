-- Tahap C3: browser tests of an app's preview. A test is a task of a tester employee that drives a browser through
-- platform tools (browser_open / browser_act / browser_look) and ends with report_app_test (passed / findings).
CREATE TABLE IF NOT EXISTS "app_tests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "environment_id" uuid NOT NULL REFERENCES "app_environments"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  -- the preview's commit when the test started (what the result is about)
  "commit" text,
  -- running | passed | findings | error
  "status" text DEFAULT 'running' NOT NULL,
  "focus" text DEFAULT '' NOT NULL,
  "roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "summary" text,
  "findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- a person dealt with the findings (fix tasks made, or dismissed): they leave "Needs a decision"
  "handled_at" timestamp with time zone,
  "handled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_tests_app" ON "app_tests" ("app_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_tests_task" ON "app_tests" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_tests_ws_status" ON "app_tests" ("workspace_id", "status");
