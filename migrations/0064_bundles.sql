-- Bundles (src/bundles.js): a creator groups 2 to 10 of their own paid games. Each game is still bought on its own, one
-- checkout and one purchase each, so refunds and disputes work as for any game; a player who owns any other game of a
-- bundle gets the bundle's discount on the rest ("complete the set").
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  percent_off INTEGER NOT NULL,                  -- off each remaining game's regular price, 5 to 60
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bundles_owner ON bundles(owner_id, created_at);
CREATE TABLE IF NOT EXISTS bundle_games (
  bundle_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, project_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bundle_games_project ON bundle_games(project_id);
