-- Per-game storage. Every game may hold up to the platform default (setting bundle_max_bytes) in its files; an admin can
-- set a different amount for one game, directly or by approving a creator's request for more.
ALTER TABLE projects ADD COLUMN storage_bytes INTEGER;   -- NULL: the platform default

CREATE TABLE IF NOT EXISTS storage_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,          -- the storage asked for, in total (not on top)
  quota_bytes INTEGER NOT NULL,    -- the game's storage when it asked
  used_bytes INTEGER NOT NULL,     -- what its files added up to when it asked
  reason TEXT NOT NULL,            -- why procedural generation or loading at run time does not cover it
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied | withdrawn
  granted_bytes INTEGER,
  note TEXT,                       -- the admin's answer, shown to the creator
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS storage_requests_status ON storage_requests (status, created_at);
CREATE INDEX IF NOT EXISTS storage_requests_project ON storage_requests (project_id, created_at);
