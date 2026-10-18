-- Tahap C2: data-driven HR reviews. A review is a task of an HR employee about one employee: the metrics are
-- computed by the platform (exact), the HR employee writes the assessment and may propose new instructions; those go
-- through a Replay and a judge, and apply on their own only when the replay passes (else a person decides).
CREATE TABLE IF NOT EXISTS "hr_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "reviewer_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "period_days" integer DEFAULT 30 NOT NULL,
  "metrics" jsonb NOT NULL,
  -- the platform's score from the metrics (1-5, null: not enough work to judge)
  "metric_score" integer,
  -- the HR employee's score (1-5)
  "score" integer,
  "summary" text,
  "strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- running | done | error
  "status" text DEFAULT 'running' NOT NULL,
  "replay_id" uuid REFERENCES "replays"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_reviews_employee" ON "hr_reviews" ("employee_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hr_reviews_task" ON "hr_reviews" ("reviewer_task_id");
--> statement-breakpoint
ALTER TABLE "replays" ADD COLUMN IF NOT EXISTS "hr_review_id" uuid REFERENCES "hr_reviews"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- the judge's verdict per replayed task and whether the change passed ({ passed, verdicts: [...], model })
ALTER TABLE "replays" ADD COLUMN IF NOT EXISTS "judge" jsonb;
--> statement-breakpoint
ALTER TABLE "replays" ADD COLUMN IF NOT EXISTS "auto_applied" boolean DEFAULT false NOT NULL;
