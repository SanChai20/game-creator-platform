-- Store quality (src/store-quality.ts): the New shelf, engagement numbers for ranking and graduation, games hidden from
-- the store by player reports, and the reports themselves.

-- Which shelf a live game is on: 'new' (the New shelf, where every new game starts) or 'main' (the main store). Every game
-- that was ever published before this existed is grandfathered onto the main store.
ALTER TABLE projects ADD COLUMN shelf TEXT NOT NULL DEFAULT 'new';
ALTER TABLE projects ADD COLUMN shelf_at INTEGER;   -- when it moved to the main store
UPDATE projects SET shelf = 'main', shelf_at = published_at WHERE published_at IS NOT NULL;

-- How players stick with the game, from player_games (refreshed by the schedule): players other than the creator, their
-- average play time, the share who left within a minute and never came back, and the share who came back another day.
ALTER TABLE projects ADD COLUMN eng_players INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN eng_avg_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN eng_quit INTEGER NOT NULL DEFAULT 0;     -- percent
ALTER TABLE projects ADD COLUMN eng_return INTEGER NOT NULL DEFAULT 0;   -- percent
ALTER TABLE projects ADD COLUMN eng_at INTEGER;

-- Hidden from the store (lists, search, shelves, picks) until an admin reviews it. The game stays playable by its link,
-- so players who bought it keep it. hidden_reason: 'reports' (player reports reached the threshold) or 'admin'.
ALTER TABLE projects ADD COLUMN hidden_at INTEGER;
ALTER TABLE projects ADD COLUMN hidden_reason TEXT;

-- One report per player and game. status: open | dismissed (an admin found nothing wrong) | upheld (an admin acted on it)
-- | superseded (a newer version went live, which brings the game back by itself).
CREATE TABLE game_reports (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  version INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX game_reports_open ON game_reports(status, project_id);

CREATE INDEX projects_shelf ON projects(status, shelf, recent);

-- Numbers the schedule works out from the whole store to tune the ranking by itself (src/store-quality.ts, tuneStmts):
-- time_scale_s (twice the typical time per player) and return_scale (twice the typical share of returning players).
CREATE TABLE store_tuning (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,   -- how many games it was worked out from
  updated_at INTEGER NOT NULL
);
