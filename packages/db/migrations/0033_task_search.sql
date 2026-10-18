-- Tahap C7: Ctrl+K search over a workspace's tasks (title + brief), full-text with the 'simple' configuration
-- (no stemming: Indonesian and English titles alike, prefix matches). The API's expression must match this one.
CREATE INDEX IF NOT EXISTS "tasks_search" ON "tasks" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("brief", '')));
