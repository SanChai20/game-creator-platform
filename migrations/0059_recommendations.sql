-- For you recommendations (src/recommend.js): games a player said "not for me" to, kept out of their list.
CREATE TABLE IF NOT EXISTS rec_dismissed (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;
