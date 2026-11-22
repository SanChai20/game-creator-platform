-- Limited-time sales (src/sales.ts). A creator puts a paid game on sale at a lower price for a number of days; the store
-- shows the sale price, the regular price struck through and when the sale ends, and checkout charges the sale price
-- until sale_ends_at. One sale at a time per game; the columns keep the last sale after it ends (the gap between sales
-- is counted from sale_ends_at). What a buyer paid is always purchases.price_cents (Stripe's amount_total), which is
-- what a refund gives back.
ALTER TABLE projects ADD COLUMN sale_price_cents INTEGER NOT NULL DEFAULT 0;   -- 0: never on sale
ALTER TABLE projects ADD COLUMN sale_starts_at INTEGER;
ALTER TABLE projects ADD COLUMN sale_ends_at INTEGER;                          -- the sale price applies while now < this
-- When the regular price last went up: a sale cannot start soon after, so the struck-through price is one the game
-- really sold at (the price shown as "was" must be the game's price before the sale, not one raised for it).
ALTER TABLE projects ADD COLUMN price_raised_at INTEGER;
CREATE INDEX projects_on_sale ON projects (sale_ends_at) WHERE sale_price_cents > 0;
