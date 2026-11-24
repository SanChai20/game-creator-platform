-- Gifts between friends (src/gifts.ts). A player asks a friend to gift them a paid game, or a player buys a game for a
-- friend directly. The friend pays through Stripe Checkout and the game lands with the recipient: the purchase row is the
-- recipient's (purchases.user_id), with the payer in gifted_by. The creator is credited exactly as for any other sale.
-- Gifts are non-refundable: the buyer cannot refund one, the recipient cannot either, and an admin's refund refuses it
-- (a refund or a chargeback made in Stripe itself still takes the game back and the creator's credit, as for any sale).
ALTER TABLE purchases ADD COLUMN gifted_by TEXT;              -- the friend who paid; NULL for a player's own purchase
CREATE INDEX purchases_gifted_by ON purchases(gifted_by, created_at) WHERE gifted_by IS NOT NULL;

-- "Gift me this game": from_id asks to_id (a friend) to buy project_id for them.
CREATE TABLE gift_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,                        -- who wants the game (the recipient of the gift)
  to_id TEXT NOT NULL,                          -- the friend asked to pay
  project_id TEXT NOT NULL,
  note TEXT,                                    -- the asker's own words, optional
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | gifted | declined | cancelled | closed (owned another way, or unfriended)
  purchase_id TEXT,                             -- the gift that answered it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER
);
-- one open request per friend and game
CREATE UNIQUE INDEX gift_requests_open ON gift_requests(from_id, to_id, project_id) WHERE status = 'pending';
CREATE INDEX gift_requests_to ON gift_requests(to_id, status, created_at);
CREATE INDEX gift_requests_from ON gift_requests(from_id, status, created_at);
CREATE INDEX gift_requests_age ON gift_requests(created_at);
