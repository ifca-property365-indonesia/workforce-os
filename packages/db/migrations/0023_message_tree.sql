-- Conversations become trees: every message points at its parent, the conversation remembers its active leaf,
-- so editing a message or regenerating a reply forks a branch and keeps the old one.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "parent_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "active_leaf_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Backfill: existing threads are linear, so each message's parent is the one before it.
UPDATE "messages" m SET "parent_id" = p."prev"
FROM (SELECT "id", LAG("id") OVER (PARTITION BY "conversation_id" ORDER BY "created_at", "id") AS "prev" FROM "messages") p
WHERE m."id" = p."id" AND m."parent_id" IS NULL AND p."prev" IS NOT NULL;
--> statement-breakpoint
UPDATE "conversations" c SET "active_leaf_id" = l."id"
FROM (SELECT DISTINCT ON ("conversation_id") "conversation_id", "id" FROM "messages" ORDER BY "conversation_id", "created_at" DESC, "id" DESC) l
WHERE c."id" = l."conversation_id" AND c."active_leaf_id" IS NULL;
--> statement-breakpoint
-- Index after the backfill so the bulk update does not maintain it row by row.
CREATE INDEX IF NOT EXISTS "messages_parent" ON "messages" ("parent_id");
