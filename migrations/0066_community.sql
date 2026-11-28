-- Creator replies and the community board (src/community.js). A game's creator answers reviews (one public reply per
-- review), and each game has a discussion board: threads and replies by signed-in players, which the creator pins,
-- locks and hides. Players report posts; enough reports hide a post until the creator or an admin looks at it.
CREATE TABLE IF NOT EXISTS review_replies (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                         -- the reviewer
  author_id TEXT NOT NULL,                       -- the creator (or an admin) who replied
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS board_posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  thread_id TEXT,                                -- null: this post starts a thread
  user_id TEXT NOT NULL,
  title TEXT,                                    -- threads only
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,             -- threads only, set by the creator
  locked INTEGER NOT NULL DEFAULT 0,             -- threads only: no new replies
  replies INTEGER NOT NULL DEFAULT 0,            -- threads only: visible replies
  reports INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,
  hidden_by TEXT,                                -- creator | admin | reports | author
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL                       -- threads: the latest visible post
);
CREATE INDEX IF NOT EXISTS board_threads ON board_posts(project_id, thread_id, pinned, last_at);
CREATE INDEX IF NOT EXISTS board_replies ON board_posts(thread_id, created_at);
CREATE INDEX IF NOT EXISTS board_user ON board_posts(user_id, created_at);
CREATE TABLE IF NOT EXISTS board_reports (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
) WITHOUT ROWID;
ALTER TABLE projects ADD COLUMN board_off INTEGER NOT NULL DEFAULT 0;
