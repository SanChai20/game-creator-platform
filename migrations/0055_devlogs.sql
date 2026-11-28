-- Devlogs and patch notes (src/devlogs.js): posts a creator writes on a game's page, and the notes that go live with a
-- version. Followers of the creator and players who keep, bought or recently played the game hear about each one under
-- the bell (notifications kind 'devlog', data {"project": id, "devlog": id}).
CREATE TABLE IF NOT EXISTS devlogs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'post',            -- post | patch
  version INTEGER,                              -- the version a patch note went live with
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,          -- players told under the bell
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- a game's posts, newest first
CREATE INDEX IF NOT EXISTS devlogs_project ON devlogs(project_id, created_at);
-- one patch note per version
CREATE UNIQUE INDEX IF NOT EXISTS devlogs_patch ON devlogs(project_id, version) WHERE kind = 'patch';
-- patch notes an agent hands to publish, posted when that version goes live (src/pipeline.ts)
ALTER TABLE versions ADD COLUMN patch_notes TEXT;
