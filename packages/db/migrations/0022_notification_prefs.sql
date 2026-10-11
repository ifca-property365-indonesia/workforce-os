-- Per-user notifications: optional recipient, per-user read state, per-user channel preferences and muted employees.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_reads" (
  "notification_id" uuid NOT NULL REFERENCES "notifications"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("notification_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_prefs" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "channels" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "muted_employee_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "workspace_id")
);
--> statement-breakpoint
-- No per-member backfill: a notification read before this migration (notifications.read_at set) counts as read
-- for every member; per-user reads are recorded from now on.
