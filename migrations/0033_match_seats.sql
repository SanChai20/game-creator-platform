-- Coming back to a running match (GCP.match.rejoin): the match each player was last put in, per game and environment.
-- One row per player and game, replaced when the matchmaker starts their next match, so finding the match to go back
-- to after a reload is one read by key however many matches a game runs (src/routes/rt.ts match-current).
CREATE TABLE IF NOT EXISTS match_seats (
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,                            -- live | preview
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, env, user_id)
);
CREATE INDEX IF NOT EXISTS match_seats_age ON match_seats(created_at);
