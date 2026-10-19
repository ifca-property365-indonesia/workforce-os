-- Tahap C4: skills from the open catalog (skills.sh / GitHub), pinned to a commit with their license and hash, and the
-- HR employee's skill audits. A newer commit is only ever noted (update_available); a person applies it.
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "origin" jsonb;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "files" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "update_available" jsonb;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "origin_checked_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_audit_tasks" (
  "task_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- monthly | manual
  "trigger" text DEFAULT 'manual' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
