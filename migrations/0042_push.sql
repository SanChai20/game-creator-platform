-- Push notifications (src/push.ts). One row per browser that turned notifications on: its push subscription, the
-- sign-in it was made under (a subscription stops when that sign-in ends, so a shared device that signed out gets
-- nothing more for the old account) and the language its notifications are written in.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,                 -- the browser's push service address (src/push-core.ts pushEndpointOk)
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,                  -- sessions.id it was made under
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  ua TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
-- What each account switched off ("requests,invites,messages"); no row: everything on.
CREATE TABLE push_prefs (
  user_id TEXT PRIMARY KEY,
  off TEXT NOT NULL DEFAULT ''
);
-- The platform's VAPID key pair, made on first use (id 1). The private key is sealed with a key derived from SESSION_SECRET.
CREATE TABLE push_keys (
  id INTEGER PRIMARY KEY,
  public_key TEXT NOT NULL,
  sealed_private TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
