-- What a routine does when its previous firing is still running: skip (default) or queue another run.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "overlap" text NOT NULL DEFAULT 'skip';
--> statement-breakpoint
-- A routine proposed by a tainted run (approved by a person, but its brief came from untrusted content): every
-- firing creates tasks that start tainted.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "untrusted_input" boolean NOT NULL DEFAULT false;
