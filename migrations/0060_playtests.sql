-- Playtests (src/playtests.js): a creator invites real players to the preview version through a link, asks them a few
-- questions afterwards, and reads how each tester played (sessions, play time, the events the game tracked) and what they
-- answered. Testers' play is on the preview, so none of it touches the live game's numbers.
CREATE TABLE IF NOT EXISTS playtests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,                     -- the preview version it was opened on; testers play the current preview
  code TEXT NOT NULL UNIQUE,                    -- the invite link's secret part
  title TEXT NOT NULL,
  note TEXT,                                    -- what the creator wants testers to try
  questions TEXT NOT NULL DEFAULT '[]',         -- JSON: up to 5 questions, each a string
  seats INTEGER NOT NULL DEFAULT 50,            -- testers it takes at most
  status TEXT NOT NULL DEFAULT 'open',          -- open | closed
  created_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS playtests_project ON playtests(project_id, created_at);
CREATE TABLE IF NOT EXISTS playtest_testers (
  playtest_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  answered_at INTEGER,
  fun INTEGER,                                  -- 1 to 5: how much they enjoyed it
  answers TEXT,                                 -- JSON: one answer per question, in order
  PRIMARY KEY (playtest_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS playtest_testers_user ON playtest_testers(user_id);
