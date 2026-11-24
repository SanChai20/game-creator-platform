-- Following creators (src/follows.js). A player follows a creator to hear when they publish a new game: the news is a
-- row in notifications (kind 'new_game', actor_id the creator, data {"project": id}), shown under the bell in the top bar.
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, creator_id)
) WITHOUT ROWID;
-- a creator's followers: the count on their profile, and who hears about a new game
CREATE INDEX IF NOT EXISTS follows_creator ON follows(creator_id, created_at);
-- the bell reads one account's notifications of one kind family, newest first
CREATE INDEX IF NOT EXISTS notifications_user_kind ON notifications(user_id, kind, id);
