-- Where each game Worker lives, so the platform can move games between hosts (standard Workers -> a Workers for
-- Platforms dispatch namespace) one at a time without breaking sessions. See docs/workers-for-platforms.md.
ALTER TABLE game_workers ADD COLUMN host TEXT NOT NULL DEFAULT 'workers';   -- 'workers' | 'dispatch:<namespace>' | 'local'
ALTER TABLE game_workers ADD COLUMN script TEXT;                           -- script name in that host (gcp-<pid>-<env>)
ALTER TABLE game_workers ADD COLUMN retired_host TEXT;                     -- the host it was moved from, until that copy is deleted
ALTER TABLE game_workers ADD COLUMN retired_at INTEGER;                    -- when it moved; the old copy is deleted 6 hours later
