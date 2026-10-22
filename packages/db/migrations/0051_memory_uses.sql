-- Memory you can see being used (after OpenHuman's cited memory packs): how often a memory was put in front of an
-- employee and when last. Runs record which memories they got; nightly tidy can also write "lesson" memories that
-- sum up recurring reviewer feedback.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "uses" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
