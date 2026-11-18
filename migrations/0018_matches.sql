-- Server-run matches (GCP.match): every match the matchmaker started, and ratings per game, environment and queue.
-- The match runs in the game's own Worker (GameMatch); it reports its result here once (src/routes/rt.ts match-result).
CREATE TABLE matches (
  id TEXT PRIMARY KEY,                          -- 24 hex characters, also the GameMatch Durable Object's name
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,                            -- live | preview
  queue TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '',
  roster TEXT NOT NULL,                         -- JSON [{ id, name, team, rating, k }]
  region TEXT,                                  -- the Durable Object location hint the match was created with
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT                                   -- JSON { ranking?, scores?, aborted?, reason? }
);
CREATE INDEX matches_game ON matches(project_id, env, created_at);

CREATE TABLE match_ratings (
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,
  queue TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1000,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, env, queue, user_id)
);
