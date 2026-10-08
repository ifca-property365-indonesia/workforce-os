ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_chat_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_telegram_chat" ON "users" ("telegram_chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_link_codes" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_callbacks" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE cascade,
  "action" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);
