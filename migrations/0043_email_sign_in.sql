-- Sign-in without passwords (src/email-auth.ts, src/passkey.ts). Creating an account takes an emailed link and the
-- account exists only once the link is opened; signing in takes a one-time code sent to the account's email, or a passkey.
-- Two-factor sign-in (0024) still follows the email code when it is on.

-- A sign-up waiting for its link to be opened. id is the sha-256 of the token in the link, so the table never holds a
-- usable one. The account is created from this row when the link is opened, never before.
CREATE TABLE IF NOT EXISTS signup_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  next TEXT,                                     -- where the person was going (a game, an agent's approval page)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS signup_links_email ON signup_links(email);

-- One-time codes sent by email: 'login' (signing in) and 'confirm' (proving it is still you before a sensitive change).
-- id is the sha-256 of the handle the browser holds; code_hash an HMAC of the code with that handle, so neither the handle
-- nor the code can be read back. user_id is NULL for an email with no account: the browser gets a handle all the same,
-- and no code ever matches it, so the form does not tell who has an account.
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_codes_email ON email_codes(email);

-- Passkeys (WebAuthn). id is the credential id (base64url); public_key the credential's public key as a JWK.
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

-- A WebAuthn ceremony in progress: the challenge the browser must sign, used once, for five minutes.
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id TEXT PRIMARY KEY,                           -- the challenge itself (base64url, 32 random bytes)
  kind TEXT NOT NULL,                            -- 'register', 'login' or 'confirm'
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

-- When this sign-in last proved it is its owner (signing in, an email code or a passkey). Sensitive changes (two-factor,
-- passkeys, deleting the account) need a proof from the last few minutes.
ALTER TABLE sessions ADD COLUMN confirmed_at INTEGER;
ALTER TABLE sessions ADD COLUMN method TEXT;     -- how it signed in: 'email', 'link', 'passkey'
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

-- Passwords are gone. Every existing account signs in with a code sent to its email (or a passkey once it adds one),
-- so nobody is locked out; the hashes and any open reset links are discarded. pw_hash stays as a column (NOT NULL in
-- 0001) and is never read again.
UPDATE users SET pw_hash = '' WHERE pw_hash != '!';
DELETE FROM password_resets;
