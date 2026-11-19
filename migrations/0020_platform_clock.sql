-- Every play number is measured by the platform, never reported by the game (src/play-clock.ts).
-- plays.seen_at is now only the store page's own check-in (the page that shows the game, on the platform's origin, with
-- the player's sign-in): game heartbeats and game service calls no longer move it. plays.seconds, counted, and the totals
-- built from them (game_daily, projects.plays and seconds, player_games) are credited from those check-ins only.
-- plays.trial_until: when a free-trial session's time runs out, so the store page's check-ins can charge the trial too.
ALTER TABLE plays ADD COLUMN trial_until INTEGER;
-- "Playing now" counts sessions whose store page checked in during the last minute.
CREATE INDEX IF NOT EXISTS plays_seen ON plays(env, seen_at);
CREATE INDEX IF NOT EXISTS plays_seen_project ON plays(project_id, env, seen_at);
-- One wall clock per player and game: time credited to one session cannot be credited again to another session of the
-- same player open at the same moment (clock_at is how far that player's time in the game has been credited).
ALTER TABLE player_games ADD COLUMN clock_at INTEGER;
-- When a session became a counted play: a player adds at most one counted play per game per hour (COUNT_EVERY_MS).
ALTER TABLE plays ADD COLUMN counted_at INTEGER;
