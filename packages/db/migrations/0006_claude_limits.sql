CREATE TABLE IF NOT EXISTS "claude_limits" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "credential_source" text NOT NULL,
  "rate_limit_type" text NOT NULL,
  "status" text NOT NULL,
  "utilization" double precision,
  "resets_at" timestamp with time zone,
  "warned_threshold" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id", "credential_source", "rate_limit_type")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "quota_paused_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "quota_pause_reason" text;
