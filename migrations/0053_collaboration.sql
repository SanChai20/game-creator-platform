-- Multi-developer, multi-agent collaboration on one game (src/collab.ts, src/collab-core.ts, docs/collaboration.md),
-- modelled on a GitHub repository: collaborators with roles, branches with working copies of their own, change requests
-- (pull requests) with reviews, and a three-way merge into main.

-- Collaborators. The owner is projects.owner_id and never has a row here.
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                          -- read | write | maintain | admin
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id);

-- Invitations by email, accepted by the account signed in with that email. Pending for 7 days.
CREATE TABLE IF NOT EXISTS project_invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,                         -- lowercased
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | accepted | declined | revoked
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  user_id TEXT                                 -- who accepted or declined
);
CREATE UNIQUE INDEX IF NOT EXISTS project_invites_open ON project_invites(project_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS project_invites_email ON project_invites(email, status);

-- Branches: a working copy of its own (files rows and R2 objects under the workspace id "<project>~<branch id>"),
-- forked from a main version. main itself is the project's workspace and has no row.
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  base_version INTEGER,                        -- the main version it was forked from or last updated from (the merge base)
  head_version INTEGER,                        -- its newest deployed version
  ws_base INTEGER,                             -- the version its workspace last matched
  conflicts TEXT NOT NULL DEFAULT '[]',        -- JSON: paths a merge from main left in conflict
  status TEXT NOT NULL DEFAULT 'open',         -- open | deleted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS branches_open_name ON branches(project_id, name) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS branches_project ON branches(project_id, status);

-- Change requests (pull requests): a branch proposed for main.
CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',              -- the agent or app that opened it
  status TEXT NOT NULL DEFAULT 'open',         -- open | merged | closed
  merged_version INTEGER,
  merged_head INTEGER,                         -- the branch version that was merged
  merged_by TEXT,
  closed_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (project_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS change_requests_open_branch ON change_requests(branch_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS change_requests_project ON change_requests(project_id, status, number);

-- Reviews and comments on a change request.
CREATE TABLE IF NOT EXISTS change_reviews (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,                       -- approve | request_changes | comment
  body TEXT NOT NULL DEFAULT '',
  version INTEGER,                             -- the branch version reviewed
  path TEXT,                                   -- a comment on one file (optional)
  line INTEGER,
  dismissed INTEGER NOT NULL DEFAULT 0,
  dismissed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_reviews_change ON change_reviews(change_id, created_at);

-- A short lease per workspace, so two agents writing the same working copy at once never leave a file's bytes and its
-- recorded hash from different writes, and a deploy never freezes a half-written workspace.
CREATE TABLE IF NOT EXISTS ws_locks (
  ws TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE projects ADD COLUMN protection TEXT;                    -- JSON: main's protection (src/collab-core.ts parseProtection)
ALTER TABLE projects ADD COLUMN next_change INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN alloc_token TEXT;                   -- the last version-number allocation, so its row is written in the same transaction

ALTER TABLE versions ADD COLUMN branch TEXT;                        -- the branch id it was deployed from; NULL: main
ALTER TABLE versions ADD COLUMN change_number INTEGER;              -- the change request a merge version merged
CREATE INDEX IF NOT EXISTS versions_branch ON versions(project_id, branch, n);

ALTER TABLE uploads ADD COLUMN ws TEXT;                             -- the workspace an upload URL writes to (NULL: main)
ALTER TABLE downloads ADD COLUMN ws TEXT;                           -- the workspace a download of "the workspace" reads
