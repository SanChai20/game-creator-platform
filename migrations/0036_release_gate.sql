-- The release gate (src/release-gate.ts): one set of platform requirements, checked on the server every time a version is
-- about to go live, whatever path asked for it (the publish tool, a rollback, an admin approval, putting a game back
-- online). The pipeline checks it again right before the switch, so no client can skip it.

-- The last time the gate looked at a version: the ruleset it applied, when, and each rule's outcome (JSON).
ALTER TABLE versions ADD COLUMN gate TEXT;

-- An admin's written decision to let one version of one game go live although one rule fails. Bound to that version and
-- rule only, with a reason and an end date; rules that protect players or other creators (content, originality, files,
-- account standing) can never be waived.
CREATE TABLE release_waivers (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,                     -- the admin's user id
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  PRIMARY KEY (project_id, version, rule)
);
