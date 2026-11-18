-- The platform's own record of how long a play session stayed open, independent of the game's heartbeats: the last time
-- the store page showing the game, or any game service call (saves, scores, rooms, token renewal), reached the server.
-- Self-serve refunds count play time up to this (src/earnings.ts playedSeconds).
ALTER TABLE plays ADD COLUMN seen_at INTEGER;
