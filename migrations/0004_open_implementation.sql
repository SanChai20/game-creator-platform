-- Open implementation: a creator can let other developers' agents learn how a live game was built.
-- What is shared is a card the platform writes from the published build (facts and a summary), never code.
ALTER TABLE projects ADD COLUMN open_implementation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN open_implementation_at INTEGER;
CREATE TABLE implementations (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,                     -- the live version the card describes
  facts TEXT NOT NULL,                          -- JSON: engine, rendering, input, services, techniques, structure
  summary TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT 'rules', -- rules | ai
  reads INTEGER NOT NULL DEFAULT 0,             -- times other developers' agents read the card
  created_at INTEGER NOT NULL
);
CREATE INDEX projects_open ON projects(open_implementation, status);
