-- Storage limits that hold across games (security review, findings 2 and 10).
-- by_server: 1 for rows game server code or the creator (game_data) wrote, 0 for a player's own saves. Server code's
-- allowance per game is counted over its own rows only, so a popular game's players never use it up.
ALTER TABLE saves ADD COLUMN by_server INTEGER NOT NULL DEFAULT 0;
UPDATE saves SET by_server = 1 WHERE user_id = '';
CREATE INDEX IF NOT EXISTS saves_server ON saves (project_id) WHERE by_server = 1;
-- one player's saves over every game (the per-account quota), and the guest and continue queries that go by player
CREATE INDEX IF NOT EXISTS saves_user ON saves (user_id, by_server);

-- Hosting cleanup (security review, finding 3): a preview Worker nobody opened for a while is deleted (idle_at set) and
-- deployed again the next time the creator opens the preview; old versions' files are deleted (purged_at set).
ALTER TABLE game_workers ADD COLUMN idle_at INTEGER;
ALTER TABLE versions ADD COLUMN purged_at INTEGER;

-- Device sign-in (security review, finding 9): where the request came from, shown to the person approving it.
ALTER TABLE device_codes ADD COLUMN req_place TEXT;
ALTER TABLE device_codes ADD COLUMN req_country TEXT;

-- Account basics (security review, finding 8): a password reset link emailed to the account's address. id is the
-- sha-256 of the token in the link, so the table never holds a usable link; a link works once, for an hour.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

-- Removed games (security review, finding 12): their players' saves, stats and scores are deleted 30 days after the
-- removal, as the privacy policy says. data_purged_at marks when that happened.
ALTER TABLE projects ADD COLUMN data_purged_at INTEGER;

-- The first-admin claim link works once ever (security review, low findings): a platform that already has an admin
-- counts as claimed, so the link does not come back to life if every admin is later demoted.
INSERT INTO settings (key, value, updated_at) SELECT '_admin_claimed', '"migrated"', 0 WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
  ON CONFLICT(key) DO NOTHING;
