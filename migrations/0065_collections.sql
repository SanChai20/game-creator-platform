-- Curated collections (src/collections.js): public lists of games that players and staff put together ("best 10-minute
-- puzzlers"), each with a short note per game. Players follow a list; staff picks are shown on the store's home page.
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  public INTEGER NOT NULL DEFAULT 1,             -- 0: only its owner sees it
  staff_pick INTEGER NOT NULL DEFAULT 0,         -- set by an admin: shown on the home page
  followers INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,                             -- taken down by an admin
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_owner ON collections(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS collections_popular ON collections(public, followers);
CREATE TABLE IF NOT EXISTS collection_games (
  collection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  note TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, project_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collection_games_project ON collection_games(project_id);
CREATE TABLE IF NOT EXISTS collection_follows (
  collection_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collection_follows_user ON collection_follows(user_id, at);
