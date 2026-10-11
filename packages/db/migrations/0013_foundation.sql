-- Chat turns: a user message is "handled" once a run has folded it into a turn, so rapid messages coalesce.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "handled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "meta" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- Backfill only user messages that were already answered (an assistant row follows) or are old; a chat job still
-- queued across the deploy can then still claim its message.
UPDATE "messages" m SET "handled_at" = m."created_at"
WHERE m."role" = 'user' AND m."handled_at" IS NULL
  AND (m."created_at" < now() - interval '1 hour'
       OR EXISTS (SELECT 1 FROM "messages" a WHERE a."conversation_id" = m."conversation_id" AND a."role" = 'assistant' AND a."created_at" > m."created_at"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_unhandled" ON "messages" ("conversation_id", "created_at") WHERE "role" = 'user' AND "handled_at" IS NULL;
