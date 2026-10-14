-- App factory, Phase B2: live blue-green slots, maintenance page, database backups.
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "active_slot" text DEFAULT 'blue' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "maintenance" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "last_backup_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment_id" uuid NOT NULL REFERENCES "app_environments"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "size_bytes" bigint,
  "offsite" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp with time zone,
  "release_id" uuid REFERENCES "app_releases"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_backups_env_name" ON "app_backups" ("environment_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_backups_env" ON "app_backups" ("environment_id", "created_at");
--> statement-breakpoint
INSERT INTO "app_backups" ("environment_id", "workspace_id", "name", "kind", "release_id", "created_at")
SELECT r."environment_id", r."workspace_id", r."db_backup", 'pre_migrate', r."id", r."created_at"
FROM "app_releases" r
WHERE r."db_backup" IS NOT NULL
ON CONFLICT DO NOTHING;
