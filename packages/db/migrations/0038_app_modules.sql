-- Tahap C8: an app's modules. A module is built from its own PRD (app_documents.module_id) in the app's repository
-- and released with the app; its status is derived from its tasks (app_module_tasks), their merges and the releases
-- that contain them (app_releases.modules). Only a hold (paused / dropped) is set by a person.
CREATE TABLE IF NOT EXISTS "app_modules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  -- paused | dropped (null: active)
  "hold" text,
  -- a build or change asked for while another module of the app was being built (started when the app is free)
  "pending_work" jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_modules_slug" ON "app_modules" ("app_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_modules_ws" ON "app_modules" ("workspace_id");
--> statement-breakpoint
-- a task's work for a module: prd | build | change | register (earlier work linked without rework)
CREATE TABLE IF NOT EXISTS "app_module_tasks" (
  "task_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE CASCADE,
  "module_id" uuid NOT NULL REFERENCES "app_modules"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_module_tasks_module" ON "app_module_tasks" ("module_id", "created_at");
--> statement-breakpoint
ALTER TABLE "app_documents" ADD COLUMN IF NOT EXISTS "module_id" uuid REFERENCES "app_modules"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "app_document_tasks" ADD COLUMN IF NOT EXISTS "module_id" uuid REFERENCES "app_modules"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- version numbers count per app (documents of the whole app) and per module
DROP INDEX IF EXISTS "app_documents_version";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_documents_version" ON "app_documents" ("app_id", "kind", "version") WHERE module_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_documents_module_version" ON "app_documents" ("module_id", "kind", "version") WHERE module_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN IF NOT EXISTS "modules" jsonb;
