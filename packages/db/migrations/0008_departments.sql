CREATE TABLE IF NOT EXISTS "departments" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "name" jsonb NOT NULL,
  "sop" jsonb NOT NULL,
  "subagents" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "key")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "department" text;
