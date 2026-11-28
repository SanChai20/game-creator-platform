-- Retention and funnels (src/analytics.ts, src/events.js).
-- Store page loads per game and day, for the store funnel (page → session → counted play).
ALTER TABLE game_daily ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
-- ...of which arrived from a shared link or an embed card on another site (?ref=share, ?ref=embed; src/share.ts).
ALTER TABLE game_daily ADD COLUMN shared_views INTEGER NOT NULL DEFAULT 0;
-- Custom events a game sends with GCP.track(name, value): totals per game scope, day and event name...
CREATE TABLE IF NOT EXISTS game_events_daily (
  project_id TEXT NOT NULL,                     -- "<game>" live, "<game>:preview"
  day TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,                -- sum of the values sent with it
  PRIMARY KEY (project_id, day, name)
) WITHOUT ROWID;
-- ...and which players reached each event, for unique counts and ordered funnels.
CREATE TABLE IF NOT EXISTS event_players (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_players_user ON event_players(user_id);
-- the event names a game has used, so a typo cannot create unlimited names
CREATE TABLE IF NOT EXISTS event_names (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
) WITHOUT ROWID;
