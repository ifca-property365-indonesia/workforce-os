-- P1: goals of a workspace (optionally under a broader one, owned by a division). Tasks and projects point at one;
-- subtasks, follow-ups and project tasks inherit it, so credits can be summed per goal.
CREATE TABLE IF NOT EXISTS "goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  -- active | done | dropped
  "status" text DEFAULT 'active' NOT NULL,
  "target_date" date,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_ws" ON "goals" ("workspace_id", "status");
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "goal_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "goal_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_goal" ON "tasks" ("goal_id") WHERE goal_id IS NOT NULL;
