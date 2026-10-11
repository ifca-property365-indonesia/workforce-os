-- Approvals raised from a chat run point at the conversation and the assistant message that raised them,
-- so the chat can show them inline and post a receipt when they are decided.
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_message" ON "approvals" ("message_id") WHERE "message_id" IS NOT NULL;
