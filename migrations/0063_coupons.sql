-- Coupons and keys (src/coupons.js). A creator makes discount codes for their paid game (a percentage off, a number of
-- uses, an end date) and batches of single-use keys that give the game for free, for streamers, press and giveaways.
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,                     -- upper case letters and digits only (dashes are for show)
  kind TEXT NOT NULL,                            -- discount | key
  percent_off INTEGER,                           -- discount: 5 to 90
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  batch TEXT,                                    -- key: the batch it was made in
  note TEXT,                                     -- who it is for, as the creator wrote it
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS coupons_project ON coupons(project_id, kind, created_at);
CREATE TABLE IF NOT EXISTS coupon_uses (
  coupon_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ref TEXT,                                      -- the checkout session or the key purchase
  at INTEGER NOT NULL,
  PRIMARY KEY (coupon_id, user_id)
) WITHOUT ROWID;
