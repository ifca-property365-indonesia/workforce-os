ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_locale" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "output_language" text DEFAULT 'inherit' NOT NULL;
