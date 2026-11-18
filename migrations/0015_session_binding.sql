-- Binding every play session to the platform sign-in it was started from (src/session-binding.js).

-- The sign-in (sessions.id, the hash of the session cookie) an account's play session was started from. Signing out,
-- signing in as someone else in the same browser, or an admin suspending the account deletes that row, and every game
-- still running on it stops reaching the player's data at once. NULL for guests, the verifier and older sessions.
ALTER TABLE plays ADD COLUMN login_id TEXT;
CREATE INDEX plays_login ON plays(login_id);

-- A guest id whose progress has been moved into an account (or deliberately left behind). A claimed guest id is never
-- handed out again and its play tokens stop working, so one browser's guest progress can only ever reach one account.
CREATE TABLE guest_claims (
  guest_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                        -- the account it moved to; '' when the player chose not to move it
  claimed_at INTEGER NOT NULL,
  moved INTEGER NOT NULL DEFAULT 0,             -- games whose progress moved
  kept INTEGER NOT NULL DEFAULT 0               -- games left as they were because the account already had progress there
);
