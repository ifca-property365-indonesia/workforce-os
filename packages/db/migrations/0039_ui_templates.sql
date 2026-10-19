-- Tahap C5: UI templates. An app uses its own template, else its client's (a built-in kit id such as "korporat", or
-- custom:<ui_templates.id>); likewise its Figma file. A workspace adds its own templates next to the built-in kits.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "ui_template" text;
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "figma_url" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "ui_template" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "figma_url" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ui_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- light | dark
  "mode" text DEFAULT 'light' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "design" text NOT NULL,
  "tokens_css" text DEFAULT '' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ui_templates_ws_name" ON "ui_templates" ("workspace_id", "name");
