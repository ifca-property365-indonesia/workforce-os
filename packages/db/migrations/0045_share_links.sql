-- View-only links: a guest without an account reads the workspace (an allow-list of pages) until the link expires
-- or is revoked. Only the token's sha256 is stored.
CREATE TABLE IF NOT EXISTS "share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "opens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "share_links_token" ON "share_links" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_ws" ON "share_links" ("workspace_id", "created_at");
