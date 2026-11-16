-- Who is in each multiplayer room right now, kept by the room itself on every join and leave,
-- so creators can see room occupancy without listing Durable Objects.
CREATE TABLE room_presence (
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,                            -- live | preview
  room TEXT NOT NULL,
  players INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, env, room)
);
CREATE INDEX plays_live ON plays(project_id, env, last_beat_at);
