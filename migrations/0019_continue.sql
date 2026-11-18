-- "Continue playing": where each player left off in each game, for the store's Continue row and the player's library.
-- resume is what the game said with GCP.resume.set (JSON: label, detail, progress 0..1, at), cleared with GCP.resume.clear().
-- continue_hidden_at: the player took the game off their Continue row; it comes back by itself once they play it again
-- (last_at moves past it).
ALTER TABLE player_games ADD COLUMN resume TEXT;
ALTER TABLE player_games ADD COLUMN continue_hidden_at INTEGER;
