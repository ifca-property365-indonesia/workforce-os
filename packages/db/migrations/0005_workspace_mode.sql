ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "execution_mode" text DEFAULT 'tool' NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "egress_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agent_session_id" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "repository_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workspace_status" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "url" text NOT NULL,
  "default_branch" text DEFAULT 'main' NOT NULL,
  "token_enc" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_ws_name" ON "repositories" ("workspace_id", "name");
