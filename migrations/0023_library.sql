-- The player's game library. Paid games a player bought are in it through their purchase (purchases.status = 'paid'), so
-- they join it the moment a payment succeeds and leave it on a refund or chargeback without anything to keep in step.
-- This table holds only the free games a player added themselves.
CREATE TABLE library_games (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX library_games_user ON library_games(user_id, added_at);
