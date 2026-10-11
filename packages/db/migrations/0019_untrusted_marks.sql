-- Content that came from a tainted run (or from an imported package) keeps that mark when it is stored, so a later
-- run that reads it is tainted too: memories, messages between employees, and machine-client (API token) traffic.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "untrusted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "untrusted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "mark_untrusted" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- Retention sweep deletes deliveries older than 30 days across all triggers.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_received" ON "webhook_deliveries" ("received_at");
