-- Game refunds (src/refunds.ts). A buyer refunds a game themselves; the platform checks the rules on the server (bought
-- less than refund_window_hours ago, played less than refund_max_play_minutes, the first refund of this game) and
-- refunds at once. What it cannot settle by itself (the play time could not be confirmed, an account that refunds too
-- often, automatic refunds off, Stripe not answering) waits for an admin as a request. Every refund of a game, by the
-- buyer or an admin, gets one row here with its books. Build skills are never refundable and never get a row.
CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,                    -- purchases.id (games only)
  user_id TEXT NOT NULL,                        -- the buyer
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,                       -- the creator whose credit is held while the request is open
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,                         -- pending | refunded | denied | closed (the sale was refunded or disputed another way)
  note TEXT,                                    -- the buyer's own words, optional
  played_seconds INTEGER NOT NULL,              -- the platform's play time when the request was made
  bought_at INTEGER NOT NULL,                   -- purchases.created_at
  review_reason TEXT,                           -- why it waits for an admin: play_unconfirmed | frequent | account | manual | refund_failed
  decided_by TEXT,                              -- 'auto' or 'admin:<user id>'
  decision_note TEXT,                           -- shown to the buyer when an admin denies it
  -- the books of the refund, filled in when the money goes back
  refund_ref TEXT,                              -- Stripe refund id
  platform_fee_cents INTEGER,                   -- the platform's cut of the sale (purchases.fee_cents), given back
  creator_net_cents INTEGER,                    -- the creator's credit taken back (purchases.net_cents)
  stripe_fee_cents INTEGER,                     -- Stripe's processing fee on the charge, which Stripe keeps on a refund
  fee_bearer TEXT,                              -- who bore it: platform | creator (admin setting refund_fee_bearer)
  transfer_ref TEXT,                            -- the creator's Transfer partly reversed, when their share was already paid out
  transfer_reversal_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
-- one request per purchase: a denied request is final for that purchase
CREATE UNIQUE INDEX refund_requests_purchase ON refund_requests(purchase_id);
CREATE INDEX refund_requests_status ON refund_requests(status, created_at);
CREATE INDEX refund_requests_user ON refund_requests(user_id, created_at);

-- The new policy: a game can be refunded within 1 day of buying it, and only while it has been played for less than
-- 10 minutes. An admin who had saved the older values gets the new ones; they stay adjustable under Admin, Settings.
UPDATE settings SET value = '24' WHERE key = 'refund_window_hours';
UPDATE settings SET value = '10' WHERE key = 'refund_max_play_minutes';

-- An account that refunded too often in a short time (refund_limit_count within refund_limit_days) loses self-service:
-- from then on its refunds are requests an admin decides, until an admin gives self-service back.
ALTER TABLE users ADD COLUMN refund_review_at INTEGER;
