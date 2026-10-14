-- App factory, Phase B1: an app runs in environments (preview on the dev server, live on a client's server). The
-- environment fields move from apps to app_environments; apps keeps them (nullable, no longer maintained) so a code
-- rollback still finds them. Every existing app gets its preview environment, every release its environment.
CREATE TABLE IF NOT EXISTS "app_environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE RESTRICT,
  "instance_name" text NOT NULL,
  "domain" text NOT NULL,
  "extra_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "dns_check" jsonb,
  "port" integer NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "status_message" text,
  "current_release_id" uuid REFERENCES "app_releases"("id") ON DELETE SET NULL,
  "access_mode" text DEFAULT 'password' NOT NULL,
  "access_password_enc" text,
  "env_enc" text,
  "app_secret_enc" text,
  "db_password_enc" text,
  "memory_mb" integer DEFAULT 512 NOT NULL,
  "healthy" boolean,
  "last_health_at" timestamp with time zone,
  "last_deployed_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_env_app_kind" ON "app_environments" ("app_id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_env_server_instance" ON "app_environments" ("server_id", "instance_name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_env_server_port" ON "app_environments" ("server_id", "port");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_env_domain" ON "app_environments" ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_env_ws" ON "app_environments" ("workspace_id");
--> statement-breakpoint
INSERT INTO "app_environments" ("app_id", "workspace_id", "kind", "server_id", "instance_name", "domain", "port", "status",
  "status_message", "current_release_id", "access_mode", "access_password_enc", "env_enc", "app_secret_enc",
  "db_password_enc", "memory_mb", "healthy", "last_health_at", "last_deployed_at", "created_by", "created_at", "updated_at")
SELECT a."id", a."workspace_id", 'preview', a."server_id", a."slug", a."domain", a."port", a."status", a."status_message",
  a."current_release_id", a."access_mode", a."access_password_enc", a."env_enc", a."app_secret_enc", a."db_password_enc",
  a."memory_mb", a."healthy", a."last_health_at", a."last_deployed_at", a."created_by", a."created_at", now()
FROM "apps" a
WHERE a."server_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "app_environments" e WHERE e."app_id" = a."id" AND e."kind" = 'preview');
--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN IF NOT EXISTS "environment_id" uuid REFERENCES "app_environments"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "app_releases" ADD COLUMN IF NOT EXISTS "promoted_from_release_id" uuid REFERENCES "app_releases"("id") ON DELETE SET NULL;
--> statement-breakpoint
UPDATE "app_releases" r SET "environment_id" = e."id" FROM "app_environments" e
WHERE r."environment_id" IS NULL AND e."app_id" = r."app_id" AND e."kind" = 'preview';
--> statement-breakpoint
ALTER TABLE "app_releases" ALTER COLUMN "environment_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_releases_env" ON "app_releases" ("environment_id", "created_at");
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "server_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "domain" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "port" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "apps_server_slug";
--> statement-breakpoint
DROP INDEX IF EXISTS "apps_server_port";
--> statement-breakpoint
DROP INDEX IF EXISTS "apps_domain";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_ws_slug" ON "apps" ("workspace_id", "slug");
