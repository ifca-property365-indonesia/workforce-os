-- Tahap C1: Workspace-mode time per task, across runs (resumes, yields, retries).
-- sandbox_seconds only grows; sandbox_seconds_base is its value when a person last let the task go on (retry,
-- request changes), so the per-task limit counts from there.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sandbox_seconds" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sandbox_seconds_base" integer DEFAULT 0 NOT NULL;
