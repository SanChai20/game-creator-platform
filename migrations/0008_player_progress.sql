-- What the platform records for each player of each game. project_id is the same scope string saves use:
-- "<game id>" for live, "<game id>:preview" for preview, so the two never mix.

-- One row per player per game, kept up to date by every heartbeat (verifier sessions keep none).
CREATE TABLE player_games (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,           -- active play time (tab visible, frames advancing)
  last_version INTEGER,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX player_games_user ON player_games(user_id, last_at);

-- Named numbers a game keeps per player with GCP.stats (levels cleared, coins, best lap).
CREATE TABLE player_stats (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id, name)
);
