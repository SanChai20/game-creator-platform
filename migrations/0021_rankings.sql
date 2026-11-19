-- The store's rankings run by themselves (src/rankings.ts): no admin keeps them up.

-- Today's picks, the home page's lead: chosen once per UTC day by the scheduled job, from the platform's own play
-- numbers and ratings. slot is the order on the page; reason says why the game was picked (featured, trending, rising,
-- new, gem, free, more). Older days stay a while so a game is not picked again every day.
CREATE TABLE daily_picks (
  day TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  slot INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (day, slot)
);
CREATE INDEX daily_picks_project ON daily_picks(project_id, day);

-- Trending no longer puts admin-featured games first (featured games now go into today's picks instead), so it sorts on
-- the trending score alone. projects.recent now holds that score: activity over 14 days weighted toward the last few,
-- times a small rating factor (src/rankings.ts).
CREATE INDEX IF NOT EXISTS projects_recent ON projects(status, recent, plays);

-- When each scheduled job last ran and whether it worked, for the admin overview.
CREATE TABLE job_runs (
  job TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  runs INTEGER NOT NULL DEFAULT 0
);
