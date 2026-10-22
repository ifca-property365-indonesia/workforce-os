-- An approval nobody decides expires after this many hours and counts as declined (fail closed, after OpenHuman's
-- approval gate). 0 = never.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "approval_expiry_hours" integer DEFAULT 168 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_pending_created" ON "approvals" ("created_at") WHERE status = 'PENDING';
