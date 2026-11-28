-- Achievements (src/achievements.js): what a version declares lives in its frozen manifest (versions.manifest
-- "$.achievements"); this table holds who unlocked what, per game scope ("<game>" live, "<game>:preview").
CREATE TABLE IF NOT EXISTS achievement_unlocks (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ach_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id, ach_id)
) WITHOUT ROWID;
-- rarity: unlocks per achievement in one game
CREATE INDEX IF NOT EXISTS achievement_unlocks_ach ON achievement_unlocks(project_id, ach_id);
-- one player's unlocks everywhere (library counts, account deletion, guest cleanup)
CREATE INDEX IF NOT EXISTS achievement_unlocks_user ON achievement_unlocks(user_id, project_id);
