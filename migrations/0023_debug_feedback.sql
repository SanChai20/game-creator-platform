-- Agent debugging and creator feedback.
--
-- debug_sessions: a browser the agent drives on its game's preview through the debug_preview tool (src/debug.ts). One per
-- account at a time; a few across the platform, so the verification browser always has room. browser_id is the Browser
-- Rendering session (or the local verifier's page), play_sid the throwaway verifier identity the game runs under.
-- busy_until: a call is driving it right now (two calls never drive one browser at once).
CREATE TABLE IF NOT EXISTS debug_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  browser_id TEXT NOT NULL,
  play_sid TEXT NOT NULL,
  viewport TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  busy_until INTEGER,
  calls INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS debug_sessions_open ON debug_sessions (closed_at, expires_at);
CREATE INDEX IF NOT EXISTS debug_sessions_user ON debug_sessions (user_id, closed_at);

-- feedback: what the creator captured while playing their preview (an annotated screenshot and a note), waiting for their
-- agent. Read once: creator_feedback takes items off the queue as it returns them. owner_id is the project's owner when
-- the item was added; only that account reads or removes it. image_key is the annotated picture in R2.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  version INTEGER,
  note TEXT NOT NULL,
  marks TEXT NOT NULL,
  context TEXT NOT NULL,
  image_key TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_queue ON feedback (project_id, created_at);
CREATE INDEX IF NOT EXISTS feedback_age ON feedback (created_at);
