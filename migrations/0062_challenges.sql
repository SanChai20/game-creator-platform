-- Daily and weekly challenges (src/challenges.js). Each UTC day the platform picks one live game with a leaderboard as the
-- daily challenge: everyone gets the same seed for it (GCP.daily), and the best scores of that day on its board make
-- the day's board. Playing the daily challenge on consecutive days builds a streak. Each week one game has a shared goal:
-- minutes played by everyone together.
CREATE TABLE IF NOT EXISTS daily_challenges (
  day TEXT PRIMARY KEY,                          -- YYYY-MM-DD (UTC)
  project_id TEXT NOT NULL,
  board TEXT NOT NULL,                           -- the leaderboard the day's scores come from
  asc INTEGER NOT NULL DEFAULT 0,                -- 1: lower scores win
  seed TEXT NOT NULL,                            -- the same for every player that day
  picked_by TEXT NOT NULL DEFAULT 'auto',        -- auto | an admin's id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_challenges_project ON daily_challenges(project_id, day);
CREATE TABLE IF NOT EXISTS challenge_scores (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS challenge_scores_top ON challenge_scores(day, score);
CREATE TABLE IF NOT EXISTS challenge_streaks (
  user_id TEXT PRIMARY KEY,
  last_day TEXT NOT NULL,                        -- the last day they played the daily challenge
  streak INTEGER NOT NULL DEFAULT 0,             -- days in a row up to last_day
  best INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0                -- daily challenges played in all
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS weekly_goals (
  week TEXT PRIMARY KEY,                         -- the Monday it starts, YYYY-MM-DD (UTC)
  project_id TEXT NOT NULL,
  goal_minutes INTEGER NOT NULL,
  picked_by TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL
);
