-- Large tool results (after OpenHuman's handle preview): the model sees a preview and a handle, the full text is kept
-- here so read_output can search or slice it. Rows expire; the reaper deletes them.
CREATE TABLE IF NOT EXISTS "tool_outputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "tool" text NOT NULL,
  "content" text NOT NULL,
  "chars" integer NOT NULL,
  "shown_chars" integer NOT NULL,
  "untrusted" boolean DEFAULT false NOT NULL,
  "reads" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_outputs_ws" ON "tool_outputs" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_outputs_expires" ON "tool_outputs" ("expires_at");
