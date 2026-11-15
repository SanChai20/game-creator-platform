-- Indexes for a catalogue of tens of thousands of games: the store's "most played" order and the site-wide
-- "playing now" count (players with a recent heartbeat) without scanning every row.
CREATE INDEX IF NOT EXISTS projects_plays ON projects(status, plays);
CREATE INDEX IF NOT EXISTS plays_recent ON plays(env, last_beat_at);
