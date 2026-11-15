-- Free trials for paid games. A creator sets how many minutes of a paid game a player may play before buying.
-- The allowance belongs to the player's account, so reloading, a new browser or another device does not reset it.
ALTER TABLE projects ADD COLUMN trial_minutes INTEGER NOT NULL DEFAULT 0;   -- 0 = no free trial
ALTER TABLE plays ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;              -- 1 = a trial session of a paid game
ALTER TABLE plays ADD COLUMN trial_seconds INTEGER NOT NULL DEFAULT 0;      -- wall-clock seconds this trial session was open

CREATE TABLE trials (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,       -- trial time used across every session and device
  sessions INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
