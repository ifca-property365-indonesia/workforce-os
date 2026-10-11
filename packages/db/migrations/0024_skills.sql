-- Skills (SKILL.md): named instructions an employee can read on demand. Stored per workspace, assigned per
-- employee; learned skills are proposed by an employee and saved only after a person approves.
CREATE TABLE IF NOT EXISTS "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "source" text NOT NULL DEFAULT 'user',
  "enabled" boolean NOT NULL DEFAULT true,
  "untrusted" boolean NOT NULL DEFAULT false,
  "provenance_hash" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_ws_slug" ON "skills" ("workspace_id", "slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_skills" (
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "skill_id" uuid NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  PRIMARY KEY ("employee_id", "skill_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_skills_skill" ON "employee_skills" ("skill_id");
