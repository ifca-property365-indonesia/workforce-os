-- Organisation rebuild: divisions (on teams), membership roles, client codes, project status, per-client knowledge.
-- Departments merge into divisions: their SOP now lives on the division, their subagents become real employees.
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "key" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "code_lead_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "sop" jsonb DEFAULT '{"en":"","id":""}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "color" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "max_parallel" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "daily_budget" double precision;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_ws_key" ON "teams" ("workspace_id", "key") WHERE key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
-- Before 0031 a lead-only PATCH never added the lead to team_members: give every lead a membership in the team they
-- lead first, so the dedupe below cannot take a head's only membership away.
INSERT INTO "team_members" ("team_id", "employee_id")
  SELECT t.id, t.lead_id FROM "teams" t WHERE t.lead_id IS NOT NULL
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- One division per employee: keep the membership in the team the employee leads (the oldest such team), else the
-- oldest team. A lead whose membership in a team was removed here is no longer that team's lead.
WITH ranked AS (
  SELECT tm.team_id, tm.employee_id,
    row_number() OVER (
      PARTITION BY tm.employee_id
      ORDER BY CASE WHEN t.lead_id = tm.employee_id THEN 0 ELSE 1 END, t.created_at, t.id
    ) AS rn
  FROM "team_members" tm JOIN "teams" t ON t.id = tm.team_id
), removed AS (
  DELETE FROM "team_members" tm USING ranked r
  WHERE r.rn > 1 AND tm.team_id = r.team_id AND tm.employee_id = r.employee_id
  RETURNING tm.team_id, tm.employee_id
)
UPDATE "teams" t SET lead_id = NULL FROM removed r WHERE t.id = r.team_id AND t.lead_id = r.employee_id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_employee" ON "team_members" ("employee_id");
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "specialty" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- employees.department and the departments table are no longer used but stay for now: deploy/upgrade.sh migrates
-- while the previous release still runs (and its rollback keeps migrations), and that code selects them. A later
-- migration drops both once this release is live.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "depends_on" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN IF NOT EXISTS "actor_employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steps_actor_created" ON "steps" ("actor_employee_id", "created_at") WHERE actor_employee_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "code" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "website" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "industry" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clients_ws_code" ON "clients" ("workspace_id", "code") WHERE code <> '';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "start_date" date;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "next_milestone" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "health" text DEFAULT 'on_track' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "next_step" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "clients"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_client" ON "documents" ("client_id") WHERE client_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "clients"("id") ON DELETE CASCADE;
--> statement-breakpoint
DROP INDEX IF EXISTS "memories_emp";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_emp" ON "memories" ("employee_id", "client_id");
--> statement-breakpoint
-- the client of the run that sent an agent message: a run for another client does not see it
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "clients"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Deleting an employee with chat approvals nulled approvals.employee_id while the same statement deleted the chat
-- (conversations → messages cascade): the immediate check on message_id/conversation_id then failed. Check at commit.
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_message_id_fkey";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_conversation_id_fkey";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
