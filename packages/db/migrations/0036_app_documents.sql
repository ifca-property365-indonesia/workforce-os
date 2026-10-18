-- Tahap C9: an app's documents (PRD, business flow, test guide, presentation), versioned. A new version is a draft
-- next to the approved one (never overwrites it); a person approves or rejects it.
CREATE TABLE IF NOT EXISTS "app_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  -- prd | flow | test_guide | deck
  "kind" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  -- draft | approved | superseded | rejected
  "status" text DEFAULT 'draft' NOT NULL,
  "based_on_version" integer,
  "note" text DEFAULT '' NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "author_employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- a presentation's screenshots come from this app test (#n)
  "test_id" uuid REFERENCES "app_tests"("id") ON DELETE SET NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_documents_version" ON "app_documents" ("app_id", "kind", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_documents_ws_status" ON "app_documents" ("workspace_id", "status");
--> statement-breakpoint
-- a task asked to write one of an app's documents (save_app_document is granted for exactly that app and kind)
CREATE TABLE IF NOT EXISTS "app_document_tasks" (
  "task_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
