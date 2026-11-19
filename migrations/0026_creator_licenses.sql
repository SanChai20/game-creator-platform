-- Creator licenses: two kinds, both one-time payments. A time-limited license ("term") runs for the admin-set number of
-- days from the moment it is granted; a lifetime license never expires. users.creator says a license was granted at
-- some point; whether it still counts is creator_plan and creator_until (src/license.ts). Each grant is a payments row
-- with its own plan and end, so a refund or dispute recomputes the account's license from what is left.
ALTER TABLE users ADD COLUMN creator_plan TEXT;          -- term | lifetime (null: never licensed)
ALTER TABLE users ADD COLUMN creator_until INTEGER;      -- end of a term license (unix ms); null for lifetime
ALTER TABLE payments ADD COLUMN plan TEXT;               -- for creator_fee rows: term | lifetime
ALTER TABLE payments ADD COLUMN expires_at INTEGER;      -- for a term license: when it ends

-- Every license granted before this was the one-time "unlimited games" license: lifetime.
UPDATE payments SET plan = 'lifetime' WHERE kind = 'creator_fee' AND plan IS NULL;
UPDATE users SET creator_plan = 'lifetime', creator_until = NULL WHERE creator = 1;
