-- Fixes from the platform audit (2026-11).

-- A version that qualified only through its creator's own preview session (the verification browser could not run it,
-- e.g. a WebGPU game) waits for an admin before it can go live: heartbeats alone prove nothing about what the game shows.
ALTER TABLE versions ADD COLUMN review TEXT;            -- NULL | 'pending' | 'approved' | 'denied'
ALTER TABLE versions ADD COLUMN review_note TEXT;
ALTER TABLE versions ADD COLUMN reviewed_at INTEGER;
ALTER TABLE versions ADD COLUMN reviewed_by TEXT;
CREATE INDEX versions_review ON versions(review);

-- A leaderboard's sort order is fixed by its first score, so a later submit cannot flip MIN and MAX.
CREATE TABLE boards (
  project_id TEXT NOT NULL,                     -- scope: <game> or <game>:preview
  board TEXT NOT NULL,
  asc INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, board)
);

-- The catalogue sorts by these instead of working them out for every live game on every request (cron keeps them fresh).
ALTER TABLE projects ADD COLUMN recent INTEGER NOT NULL DEFAULT 0;     -- plays * 4 + minutes played, last 7 days
ALTER TABLE projects ADD COLUMN playing INTEGER NOT NULL DEFAULT 0;    -- distinct players with a heartbeat in the last minute
CREATE INDEX projects_trending ON projects(status, featured, recent, plays);
CREATE INDEX projects_playing ON projects(status, playing, recent);
