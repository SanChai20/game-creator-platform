-- Game Creator platform schema (D1 / SQLite). Money is integer cents (USD). Times are unix ms.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',            -- user | admin
  status TEXT NOT NULL DEFAULT 'active',        -- active | suspended
  creator INTEGER NOT NULL DEFAULT 0,           -- 1 once the one-time creator fee is paid (or granted)
  creator_since INTEGER,
  stripe_customer TEXT,
  stripe_account TEXT,                          -- Stripe Connect account id (acct_…)
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  payout_country TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                          -- sha-256 of the cookie token
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                          -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                          -- short id, also part of the Worker name
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',              -- JSON array
  controls TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | live | offline | removed
  live_version INTEGER,                         -- version number currently live
  preview_version INTEGER,                      -- version number on the preview Worker
  next_version INTEGER NOT NULL DEFAULT 1,
  cover_key TEXT,                               -- R2 key of the cover image
  price_cents INTEGER NOT NULL DEFAULT 0,       -- 0 = free; otherwise a one-time purchase price in USD cents
  sales INTEGER NOT NULL DEFAULT 0,             -- paid purchases (denormalised)
  featured INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,             -- counted plays (denormalised)
  seconds INTEGER NOT NULL DEFAULT 0,           -- counted play time
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  removed_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX projects_owner ON projects(owner_id);
CREATE INDEX projects_status ON projects(status, published_at);

-- Draft files the agent is editing (the "workspace"). Bytes live in R2 at ws/<project>/<path>.
CREATE TABLE files (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha TEXT NOT NULL,
  ctype TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

-- Immutable snapshots. Bytes live in R2 at v/<project>/<n>/<path>.
CREATE TABLE versions (
  project_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL DEFAULT '{}',          -- JSON: resolved gcp.json
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  files TEXT NOT NULL DEFAULT '[]',             -- JSON: [{path,size,sha}]
  status TEXT NOT NULL DEFAULT 'queued',        -- queued | deploying | verifying | verified | failed
  stage TEXT NOT NULL DEFAULT '',               -- human-readable progress
  report TEXT,                                  -- JSON verification report
  screenshot_key TEXT,
  human_ok INTEGER NOT NULL DEFAULT 0,          -- a real-browser preview session met the bar
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  published_at INTEGER,
  PRIMARY KEY (project_id, n)
);

CREATE TABLE events (                           -- per-project activity log shown in the console
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  version INTEGER,
  actor TEXT NOT NULL DEFAULT '',               -- agent client name, 'console', 'admin', 'system'
  created_at INTEGER NOT NULL
);
CREATE INDEX events_project ON events(project_id, id);

CREATE TABLE uploads (                          -- short-lived signed upload grants (for curl)
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE plays (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  env TEXT NOT NULL,                            -- live | preview
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'player',          -- player | owner | verify
  started_at INTEGER NOT NULL,
  last_beat_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  frames INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  ua TEXT
);
CREATE INDEX plays_project ON plays(project_id, started_at);
CREATE INDEX plays_user ON plays(user_id, project_id, started_at);

CREATE TABLE game_daily (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  sessions INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,             -- sessions that passed the minimum play time
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);

CREATE TABLE reviews (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE client_errors (                    -- runtime errors reported by the SDK from real sessions
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  env TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX client_errors_key ON client_errors(project_id, version, env, message);

-- Platform-provided game data services
CREATE TABLE saves (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                        -- '' for game-wide shared data
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id, k)
);
CREATE TABLE scores (
  project_id TEXT NOT NULL,
  board TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, board, user_id)
);
CREATE INDEX scores_top ON scores(project_id, board, score);

-- Money
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- creator_fee
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  provider TEXT NOT NULL,                       -- stripe | admin
  provider_ref TEXT UNIQUE,
  status TEXT NOT NULL,                         -- paid | refunded
  created_at INTEGER NOT NULL
);
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- sale | refund | withdrawal | withdrawal_reversal | adjustment
  amount_cents INTEGER NOT NULL,                -- positive credits, negative debits
  ref TEXT,
  note TEXT NOT NULL DEFAULT '',
  available_at INTEGER NOT NULL,                -- sale credits become withdrawable after the hold period
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_user ON ledger(user_id, id);
CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,                         -- stripe | manual
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                         -- pending | paid | failed | rejected
  provider_ref TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX withdrawals_user ON withdrawals(user_id, created_at);
-- A player buying a paid game. The buyer pays the platform; the platform keeps its fee and credits the rest to the creator.
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,                       -- creator credited for the sale
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,                   -- platform cut (plus any processing cost passed on)
  net_cents INTEGER NOT NULL,                   -- credited to the creator
  provider TEXT NOT NULL,                       -- stripe | admin
  provider_ref TEXT UNIQUE,                     -- checkout session id
  payment_intent TEXT,
  status TEXT NOT NULL,                         -- paid | refunded
  created_at INTEGER NOT NULL,
  refunded_at INTEGER
);
CREATE UNIQUE INDEX purchases_once ON purchases(user_id, project_id) WHERE status = 'paid';
CREATE INDEX purchases_project ON purchases(project_id, created_at);
CREATE INDEX purchases_owner ON purchases(owner_id, created_at);
CREATE INDEX purchases_pi ON purchases(payment_intent);

CREATE TABLE rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
