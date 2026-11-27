-- The ACP workbench (src/acp.ts): creators' own coding agents, connected to the console through a bridge on their machine.
-- A link is one machine's standing connection (its secret is kept hashed; the bridge keeps the secret in
-- ~/.hearthcade/workbench.json). A pair is the short sign-in that creates a link: the bridge shows a code, the creator
-- approves it in the console, the bridge's next poll receives the secret once.
CREATE TABLE acp_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  os TEXT,
  project_ids TEXT,                -- NULL: every project; a JSON array: only these (like an MCP grant)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX acp_links_user ON acp_links(user_id, revoked_at);

CREATE TABLE acp_pairs (
  id TEXT PRIMARY KEY,             -- sha256 of the poll secret the bridge holds
  code TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  agent TEXT NOT NULL,
  cwd TEXT,
  os TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied | used
  user_id TEXT,
  project_ids TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  req_place TEXT,
  req_country TEXT
);
CREATE INDEX acp_pairs_expiry ON acp_pairs(expires_at);

-- One row per running bridge: the MCP grant it was given, revoked when it stops or its link is removed.
CREATE TABLE acp_bridges (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grant_id TEXT,
  agent TEXT,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE INDEX acp_bridges_link ON acp_bridges(link_id, stopped_at);
CREATE INDEX acp_bridges_user ON acp_bridges(user_id, created_at);
