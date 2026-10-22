-- Webhook triage (after OpenHuman's trigger triage): a trigger may have each delivery sorted first by a fast model
-- into drop / note / task / escalate, following the admin's rules. The payload waits in pending_payload until then.
ALTER TABLE "webhook_triggers" ADD COLUMN IF NOT EXISTS "triage" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD COLUMN IF NOT EXISTS "triage_rules" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "triage_reason" text;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "pending_payload" text;
