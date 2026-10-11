-- Who answers an un-mentioned message in a team chat: lead | everyone | mentions | auto (fast classifier).
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "responder_mode" text NOT NULL DEFAULT 'lead';
--> statement-breakpoint
-- Price row for the routing classifier model (credits per 1K tokens; 1 credit = $0.01). Seed only adds rows
-- on fresh installs, so existing installs get it here.
INSERT INTO "model_prices" ("model", "label", "input_per_1k", "output_per_1k", "cache_read_per_1k", "cache_write_per_1k")
VALUES ('claude-haiku-5-5', 'Claude Haiku 5.5', 0.01, 0.05, 0.001, 0.0125)
ON CONFLICT DO NOTHING;
