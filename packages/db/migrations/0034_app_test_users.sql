-- Tahap C10: test accounts per role on an app's preview, made by the app's own `testUsers` script after each preview
-- release (or added by hand). One shared password per environment (WFOS_TEST_PASSWORD in its env file), encrypted;
-- each account may carry a TOTP key (encrypted) so a tester can sign in through two-factor too.
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "test_password_enc" text;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "test_users_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN IF NOT EXISTS "test_users_note" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_test_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "environment_id" uuid NOT NULL REFERENCES "app_environments"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "label" text NOT NULL,
  "username" text NOT NULL,
  -- null: the environment's shared test password
  "password_enc" text,
  "totp_enc" text,
  "login_path" text DEFAULT '/' NOT NULL,
  -- auto: from the testUsers script (replaced on every preview release); manual: added by a person (kept)
  "source" text DEFAULT 'auto' NOT NULL,
  -- this account sees everything (the one a tester or a deck uses for a tour)
  "view_all" boolean DEFAULT false NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_test_users_env_role" ON "app_test_users" ("environment_id", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_test_users_ws" ON "app_test_users" ("workspace_id");
