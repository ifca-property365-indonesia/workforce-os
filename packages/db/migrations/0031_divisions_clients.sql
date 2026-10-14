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
-- one division per employee: an employee in several teams keeps the oldest membership
DELETE FROM "team_members" tm USING "teams" t
  WHERE t.id = tm.team_id
    AND EXISTS (
      SELECT 1 FROM "team_members" tm2 JOIN "teams" t2 ON t2.id = tm2.team_id
      WHERE tm2.employee_id = tm.employee_id AND (t2.created_at, t2.id) < (t.created_at, t.id)
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_employee" ON "team_members" ("employee_id");
--> statement-breakpoint
-- a lead who lost their membership above is no longer that team's lead
UPDATE "teams" t SET lead_id = NULL
  WHERE lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "team_members" tm WHERE tm.team_id = t.id AND tm.employee_id = t.lead_id);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "specialty" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "employees" DROP COLUMN IF EXISTS "department";
--> statement-breakpoint
DROP TABLE IF EXISTS "departments";
--> statement-breakpoint
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
-- Deleting an employee with chat approvals nulled approvals.employee_id while the same statement deleted the chat
-- (conversations → messages cascade): the immediate check on message_id/conversation_id then failed. Check at commit.
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_message_id_fkey";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_conversation_id_fkey";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
