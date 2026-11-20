-- Shared game host (src/game-host.ts): with DEPLOY_DRIVER "shared" a game with server-run matches (server/match.js)
-- still gets a standard Worker of its own, so the runtime rollout needs to know which games those are.
ALTER TABLE game_workers ADD COLUMN matches INTEGER NOT NULL DEFAULT 0;
