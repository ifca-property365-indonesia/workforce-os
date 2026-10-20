-- P4: what a task may do (standard | ask | plan: neither takes an irreversible action) and who accepts its result
-- (auto | person: it waits in Needs a decision until a person accepts it).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "review_policy" text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_person_review" ON "tasks" ("workspace_id") WHERE review_policy = 'person' AND reviewed_at IS NULL AND status = 'DONE';
