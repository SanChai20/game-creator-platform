-- Clips (src/clips.js): short recordings players make of a game while they play it (at most 30 seconds, video only),
-- shared by link. The video is in R2 (FILES, clips/<id>.<ext>); the creator can turn clips off for their game and remove
-- any clip of it; enough reports hide a clip until an admin looks at it.
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  type TEXT NOT NULL,                            -- video/webm | video/mp4
  bytes INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  title TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,
  hidden_by TEXT,                                -- creator | admin | reports
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_by_game ON clips(project_id, hidden_at, created_at);
CREATE INDEX IF NOT EXISTS clips_by_user ON clips(user_id, created_at);
CREATE TABLE IF NOT EXISTS clip_reports (
  clip_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (clip_id, user_id)
) WITHOUT ROWID;
ALTER TABLE projects ADD COLUMN clips_off INTEGER NOT NULL DEFAULT 0;
