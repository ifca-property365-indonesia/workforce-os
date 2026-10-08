ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deadline" date;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "progress" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Jakarta' NOT NULL;
