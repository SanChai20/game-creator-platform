-- Player-made levels (src/levels.js): levels, maps or mods that players make inside a game that supports them and share
-- with everyone who plays it. The game hands over its own JSON (GCP.levels.publish); the platform stores it, lists it on
-- a shelf on the game page and in the game (GCP.levels.list), and opens the game with it (GCP.launch.level). Players
-- who played a level rate it from 1 to 5 stars. The creator can turn sharing off and hide any level; enough reports
-- hide one until an admin looks at it.
CREATE TABLE IF NOT EXISTS levels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'live',              -- live | preview (a preview's levels stay in the preview)
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  data TEXT NOT NULL,                            -- the game's JSON, at most 256 KB
  bytes INTEGER NOT NULL,
  game_version INTEGER,                          -- the version it was made with
  plays INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  ratings INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,
  hidden_by TEXT,                                -- creator | admin | reports
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS levels_by_game ON levels(project_id, env, hidden_at, created_at);
CREATE INDEX IF NOT EXISTS levels_by_user ON levels(user_id, project_id);
-- one row per player who opened a level: plays count once each, and only they can rate it
CREATE TABLE IF NOT EXISTS level_plays (
  level_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stars INTEGER,                                 -- 1..5 once rated
  played_at INTEGER NOT NULL,
  PRIMARY KEY (level_id, user_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS level_reports (
  level_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (level_id, user_id)
) WITHOUT ROWID;
ALTER TABLE projects ADD COLUMN levels_off INTEGER NOT NULL DEFAULT 0;
