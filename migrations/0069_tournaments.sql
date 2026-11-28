-- Tournaments (src/tournaments.js) on top of matchmaking: timed cups, where every match played in the cup's queue during
-- its window earns points, and single-elimination brackets, where a player's search in the game's queue during a
-- round meets only their bracket opponent. Run by a game's creator for their game, or by the platform (official).
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  prize TEXT,
  kind TEXT NOT NULL,                            -- cup | bracket
  queue TEXT NOT NULL,                           -- the GCP.match.find queue it runs on
  starts_at INTEGER NOT NULL,                    -- sign-up closes (bracket) / scoring opens (cup)
  ends_at INTEGER,                               -- cup: scoring closes
  round_minutes INTEGER NOT NULL DEFAULT 60,     -- bracket: time to play each round
  max_players INTEGER NOT NULL DEFAULT 64,
  status TEXT NOT NULL DEFAULT 'signup',         -- signup | running | done | cancelled
  round INTEGER NOT NULL DEFAULT 0,              -- bracket: the round being played (1 = first)
  round_ends_at INTEGER,
  winner_id TEXT,
  official INTEGER NOT NULL DEFAULT 0,           -- run by the platform
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tournaments_game ON tournaments(project_id, status, starts_at);
CREATE INDEX IF NOT EXISTS tournaments_status ON tournaments(status, starts_at);
CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seed INTEGER,                                  -- bracket: 1 is the strongest by rating when it started
  points INTEGER NOT NULL DEFAULT 0,             -- cup: 3 a win, 1 a match played
  wins INTEGER NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  out_round INTEGER,                             -- bracket: the round they lost in
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tournament_players_user ON tournament_players(user_id);
CREATE TABLE IF NOT EXISTS tournament_matches (
  tournament_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  slot INTEGER NOT NULL,                         -- position in the round, from 0
  a TEXT,                                        -- null: an empty place (a bye)
  b TEXT,
  a_ready INTEGER,                               -- when each one searched for this match
  b_ready INTEGER,
  winner TEXT,
  match_id TEXT,
  decided_by TEXT,                               -- match | bye | no_show | seed
  decided_at INTEGER,
  PRIMARY KEY (tournament_id, round, slot)
) WITHOUT ROWID;
