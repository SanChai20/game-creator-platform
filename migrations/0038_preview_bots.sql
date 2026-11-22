-- Preview test bots (src/bots.ts): a creator puts bot players into their own preview to test an online game over the
-- platform's real network path. One row per fleet: who started it, where it runs, how long, and the bot-minutes it used
-- (the daily allowance per creator counts them). Bots play with sessions of kind 'bot' in the plays table, preview only;
-- those rows are removed when the fleet stops, which ends every bot connection.
CREATE TABLE bot_fleets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,                       -- the creator who started it
  do_name TEXT NOT NULL,                        -- the BotFleet Durable Object that runs it
  region TEXT NOT NULL,                         -- auto or a location hint
  bots INTEGER NOT NULL,
  target TEXT NOT NULL,                         -- follow | queue | code | room
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,                     -- the latest it may run (the per-fleet time limit)
  ended_at INTEGER,
  bot_minutes INTEGER NOT NULL DEFAULT 0,       -- bots x minutes, written when it ends (the planned amount while it runs)
  summary TEXT                                  -- JSON: why it ended, matches played, per-bot network numbers
);
CREATE INDEX bot_fleets_owner ON bot_fleets(owner_id, started_at);
CREATE INDEX bot_fleets_active ON bot_fleets(project_id, owner_id, ended_at);
