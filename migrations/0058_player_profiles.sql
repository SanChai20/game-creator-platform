-- Player profiles (src/profiles.js): who may see an account's profile, its short bio and the games it shows off.
-- Everything else on a profile (games played, play time, achievements, reviews) is read from what the platform keeps.
CREATE TABLE IF NOT EXISTS player_profiles (
  user_id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'friends',   -- everyone | friends | nobody
  bio TEXT,                                     -- up to 160 characters, plain text
  showcase TEXT,                                -- JSON: up to 6 project ids, in order; null shows the most played
  updated_at INTEGER NOT NULL
);
