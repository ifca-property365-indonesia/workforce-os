-- Personal API tokens for machine clients (the workforce-os MCP server at /api/mcp). Only a sha256 of the token
-- is stored; the token acts as its user with that user's role in the workspace.
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '["mcp"]'::jsonb,
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_hash" ON "api_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_ws_user" ON "api_tokens" ("workspace_id", "user_id");
