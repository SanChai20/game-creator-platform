-- Storage limits that hold across games (security review, findings 2 and 10).
-- by_server: 1 for rows game server code or the creator (game_data) wrote, 0 for a player's own saves. Server code's
-- allowance per game is counted over its own rows only, so a popular game's players never use it up.
ALTER TABLE saves ADD COLUMN by_server INTEGER NOT NULL DEFAULT 0;
UPDATE saves SET by_server = 1 WHERE user_id = '';
CREATE INDEX IF NOT EXISTS saves_server ON saves (project_id) WHERE by_server = 1;
-- one player's saves over every game (the per-account quota), and the guest and continue queries that go by player
CREATE INDEX IF NOT EXISTS saves_user ON saves (user_id, by_server);
