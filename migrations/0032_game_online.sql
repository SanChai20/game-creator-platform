-- Players online per game, written by each game's tally (src/clock-do.ts) when the play clock runs in Durable Objects
-- (setting play_clock_do). With the database play clock, online counts are still read from plays.seen_at.
CREATE TABLE IF NOT EXISTS game_online (
  project_id TEXT PRIMARY KEY,
  live_players INTEGER NOT NULL DEFAULT 0,
  preview_players INTEGER NOT NULL DEFAULT 0,
  live_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
