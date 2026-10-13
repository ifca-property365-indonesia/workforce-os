-- App factory, Phase A2: apps previewed on a workspace's server, and their releases (deploys / rollbacks).
CREATE TABLE IF NOT EXISTS "apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE RESTRICT,
  "client_id" uuid REFERENCES "clients"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "repository_id" uuid REFERENCES "repositories"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "domain" text NOT NULL,
  "branch" text DEFAULT 'main' NOT NULL,
  "port" integer NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "status_message" text,
  "current_release_id" uuid,
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
CREATE UNIQUE INDEX IF NOT EXISTS "apps_ws_name" ON "apps" ("workspace_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_server_slug" ON "apps" ("server_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_server_port" ON "apps" ("server_id", "port");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_domain" ON "apps" ("domain");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "commit" text NOT NULL,
  "branch" text NOT NULL,
  "commit_subject" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "trigger" text NOT NULL,
  "step" text,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "manifest" jsonb,
  "log" text DEFAULT '' NOT NULL,
  "error" text,
  "db_backup" text,
  "rollback_of_id" uuid REFERENCES "app_releases"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_releases_app" ON "app_releases" ("app_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_releases_ws_status" ON "app_releases" ("workspace_id", "status");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "apps" ADD CONSTRAINT "apps_current_release_fk" FOREIGN KEY ("current_release_id") REFERENCES "app_releases"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
