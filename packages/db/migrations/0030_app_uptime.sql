-- App factory, Phase B3: live uptime checks, certificate expiry, release windows.
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "uptime_status" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "uptime_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "uptime_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "cert_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "release_window" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_uptime_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment_id" uuid NOT NULL REFERENCES "app_environments"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ok" boolean NOT NULL,
  "status_code" integer,
  "ms" integer,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_uptime_env_at" ON "app_uptime_checks" ("environment_id", "checked_at");
