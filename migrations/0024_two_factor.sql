-- Two-factor sign-in: an authenticator app (TOTP, RFC 6238) plus single-use recovery codes, optional for every account,
-- players and creators alike (src/two-factor.ts).
-- The secrets are encrypted with a key derived from SESSION_SECRET, so a copy of the database alone cannot make codes.
ALTER TABLE users ADD COLUMN totp_secret TEXT;          -- the enabled secret (encrypted); NULL while two-factor is off
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;   -- when two-factor was turned on; NULL while it is off
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;    -- the last 30-second step a code was accepted for, so a code works once
ALTER TABLE users ADD COLUMN totp_pending TEXT;         -- a secret being set up, not yet confirmed with a code (encrypted)
ALTER TABLE users ADD COLUMN totp_pending_at INTEGER;

-- Recovery codes for when the authenticator is lost. id is the sha-256 of the code, so the table never holds a usable one.
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, id)
);

-- The second step of a sign-in: the password was right, and the code is still to come. id is the sha-256 of the token
-- the browser holds; it lasts five minutes and five wrong codes.
CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_challenges_user ON login_challenges(user_id);
