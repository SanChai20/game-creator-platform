-- Device sign-in (RFC 8628): an agent with no browser shows its user a link and a short code,
-- the user approves in their own browser, and the agent receives ordinary expiring OAuth tokens.
CREATE TABLE device_codes (
  id TEXT PRIMARY KEY,                          -- SHA-256 of the device code; the code itself is never stored
  user_code TEXT NOT NULL UNIQUE,               -- what the user sees, e.g. BCDF-GHJK
  client_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | denied | used
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX device_codes_expiry ON device_codes(expires_at);
