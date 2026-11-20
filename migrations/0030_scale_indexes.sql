-- Indexes for a catalogue of tens of thousands of games and millions of play sessions (scale review, 2026-11).
-- Each one replaces a full scan of a table that grows with every play, sale or player:

-- daily cleanup: the verifier's sessions (a few percent of plays) without reading every play
CREATE INDEX IF NOT EXISTS plays_verify ON plays(started_at) WHERE kind = 'verify';
-- the trending score reads the last 14 days of every game; written only when a game gets its first row of a day
CREATE INDEX IF NOT EXISTS game_daily_day ON game_daily(day);
-- refunds, disputes, partial refunds and withdrawals check the ledger by the purchase or withdrawal they belong to
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref, kind);
-- a game page's reviews, newest first, and its rating distribution, without sorting every review of the game
CREATE INDEX IF NOT EXISTS reviews_page ON reviews(project_id, hidden, updated_at);
CREATE INDEX IF NOT EXISTS reviews_dist ON reviews(project_id, hidden, rating);
-- deleting an account (and the daily guest and verifier cleanup) finds a player's rows in every game
CREATE INDEX IF NOT EXISTS reviews_user ON reviews(user_id);
CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id);
CREATE INDEX IF NOT EXISTS player_stats_user ON player_stats(user_id);
-- Stripe account events name the account; licenses are read per account
CREATE INDEX IF NOT EXISTS users_stripe_account ON users(stripe_account) WHERE stripe_account IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, kind, status);
-- the daily cleanup of ended sign-ins
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
-- the store's Top sort (the Bayesian average, the same expression as ORDER BY in src/routes/api.ts), so a page of it
-- is read from the index instead of sorting every live game. Partial and without a status column, so that the planner
-- never picks it for the other sorts (without table statistics it would, and every other sort would then sort all live
-- games); the Top sort names it with INDEXED BY.
CREATE INDEX IF NOT EXISTS projects_top ON projects(((rating_sum + 3.5 * 3) * 1.0 / (rating_count + 3)) DESC, rating_count DESC) WHERE status = 'live';
