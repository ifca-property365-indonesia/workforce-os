-- Memories that look after themselves: optional expiry, superseded-by links, edit time, and a journal with undo.
-- (No HNSW index: recall filters by employee, and an approximate index scan with post-filtering could silently
-- return too few memories; per-employee counts are small enough for an exact scan.)
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "superseded_by" uuid REFERENCES "memories"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "memory_id" uuid,
  "action" text NOT NULL,
  "actor" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "before" jsonb,
  "after" jsonb,
  "undone_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_events_emp" ON "memory_events" ("employee_id", "created_at");
