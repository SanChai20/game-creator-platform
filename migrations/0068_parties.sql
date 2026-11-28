-- Parties (src/parties.js): a small group of friends that stays together across games, with voice chat. The leader
-- brings the party into a game; members follow with one tap. Voice is peer to peer between the members (WebRTC); the
-- platform only passes the connection messages along (src/routes/social.ts) and keeps who is in voice.
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  leader_id TEXT NOT NULL,
  game_slug TEXT,                                -- the game the leader brought the party into, if any
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS party_members (
  user_id TEXT PRIMARY KEY,                      -- one party at a time
  party_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  voice INTEGER NOT NULL DEFAULT 0,              -- in the party's voice chat now
  voice_at INTEGER
);
CREATE INDEX IF NOT EXISTS party_members_by_party ON party_members(party_id, joined_at);
CREATE TABLE IF NOT EXISTS party_invites (
  party_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (party_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS party_invites_to ON party_invites(user_id, expires_at);
