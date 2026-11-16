-- Adult (18+) games: the live version's age rating and, for adults-only games, why (comma-separated: sexual, violence,
-- other). Set when a version goes live (src/pipeline.ts) and filled in for games published before this by the scheduled
-- backfill (src/mature.ts). The store blurs these covers and asks players to confirm before the game starts.
ALTER TABLE projects ADD COLUMN age INTEGER;
ALTER TABLE projects ADD COLUMN mature TEXT NOT NULL DEFAULT '';
