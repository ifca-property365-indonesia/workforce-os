-- App factory, Phase A: servers a workspace registers (SSH as an unprivileged user, pinned host key) to run the apps
-- its employees build.
CREATE TABLE IF NOT EXISTS "servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "host" text NOT NULL,
  "port" integer DEFAULT 22 NOT NULL,
  "username" text DEFAULT 'wfos-apps' NOT NULL,
  "role" text DEFAULT 'dev' NOT NULL,
  "base_domain" text NOT NULL,
  "host_key_algo" text,
  "host_key" text,
  "host_key_fingerprint" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "status_message" text,
  "max_running_apps" integer DEFAULT 3 NOT NULL,
  "info" jsonb,
  "last_checked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_ws_name" ON "servers" ("workspace_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_ws_domain" ON "servers" ("workspace_id", "base_domain");
