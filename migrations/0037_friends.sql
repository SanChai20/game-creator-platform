-- Friends, chat and invites (src/social-rules.js, src/social.ts, src/routes/social.ts). Who is online and what they
-- play is not stored here: it lives in each account's SocialHub Durable Object, pushed between friends' hubs.

-- One row per account that can be found and befriended: its friend code, the status it chose and its privacy choices.
CREATE TABLE IF NOT EXISTS social_profiles (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                     -- friend code (8 letters and digits), shown as XXXX-XXXX
  name_lc TEXT NOT NULL DEFAULT '',              -- lower-cased display name, for search by name
  status TEXT NOT NULL DEFAULT 'online',         -- online | away | busy | invisible (offline is when no page is open)
  requests_from TEXT NOT NULL DEFAULT 'everyone',-- everyone | friends_of_friends | nobody
  messages_from TEXT NOT NULL DEFAULT 'friends', -- friends | nobody
  invites_from TEXT NOT NULL DEFAULT 'friends',  -- friends | nobody
  show_game INTEGER NOT NULL DEFAULT 1,          -- friends see the game being played and for how long
  joinable INTEGER NOT NULL DEFAULT 1,           -- friends may join the game when it offers a place
  searchable INTEGER NOT NULL DEFAULT 1,         -- found by name (the friend code always works)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS social_profiles_name ON social_profiles(name_lc);

-- Every account that exists now gets a profile with a random code; new accounts get theirs on first use.
INSERT OR IGNORE INTO social_profiles (user_id, code, name_lc, updated_at)
  SELECT id, upper(hex(randomblob(4))), lower(name), created_at FROM users WHERE status = 'active';

-- A friendship is two rows, one each way, so a friends list is one indexed read.
CREATE TABLE IF NOT EXISTS friendships (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id, created_at);

CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL,                         -- who blocked
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked_id);

-- Direct messages between friends. pair is the two ids sorted and joined with ':'.
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',             -- text | invite
  body TEXT NOT NULL DEFAULT '',
  invite_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS dm_pair ON dm_messages(pair, id);
CREATE INDEX IF NOT EXISTS dm_unread ON dm_messages(to_id, from_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS dm_age ON dm_messages(created_at);

-- An invitation to play a game together, sent from inside the game (GCP.friends.invite) or from the platform. A match
-- invite carries the private lobby (data.lobby) that only its invitees can enter.
CREATE TABLE IF NOT EXISTS game_invites (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'live',
  kind TEXT NOT NULL DEFAULT 'game',             -- game | match | join (a friend joined through "Join")
  data TEXT NOT NULL DEFAULT '{}',               -- JSON: lobby, queue, players, min, teams, mode, label, data
  status TEXT NOT NULL DEFAULT 'sent',           -- sent | accepted | declined | cancelled
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS game_invites_to ON game_invites(to_id, status, created_at);
CREATE INDEX IF NOT EXISTS game_invites_from ON game_invites(from_id, created_at);
CREATE INDEX IF NOT EXISTS game_invites_age ON game_invites(created_at);

-- What happened that the player has not seen yet (a request arrived, a request was accepted).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                            -- friend_request | friend_accepted
  actor_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS notifications_age ON notifications(created_at);

-- A player reports another player (a message, spam requests, invites, a name). Admins handle them under Admin, Reports.
CREATE TABLE IF NOT EXISTS social_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,                          -- spam | harassment | hate | cheating | name | other
  detail TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '{}',            -- JSON: the reported messages, copied at the time of the report
  status TEXT NOT NULL DEFAULT 'open',           -- open | dismissed | actioned
  created_at INTEGER NOT NULL,
  handled_by TEXT,
  handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS social_reports_status ON social_reports(status, created_at);
CREATE INDEX IF NOT EXISTS social_reports_reporter ON social_reports(reporter_id, target_id);
