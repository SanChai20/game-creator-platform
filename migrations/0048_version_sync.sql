-- Working on one game from more than one machine (src/version-sync.ts): any agent signed in to the account can download
-- a version (pull_version), put a version's files back into the workspace (checkout_version), compare two versions
-- (diff_versions), and deploy with base_version, which is refused when someone else deployed a newer version since.
ALTER TABLE projects ADD COLUMN ws_base INTEGER;              -- the version the workspace last matched (deployed or checked out); NULL before the first
ALTER TABLE versions ADD COLUMN base INTEGER;                 -- the version this one was built on, when the deploy said (base_version) or the platform knew
ALTER TABLE versions ADD COLUMN actor TEXT NOT NULL DEFAULT '';   -- who deployed it: the agent app's name, plus the machine label it gave (by)

-- Short-lived download grants for curl (pull_version), like uploads. version NULL: the workspace as it is now.
CREATE TABLE downloads (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER,
  expires_at INTEGER NOT NULL
);
