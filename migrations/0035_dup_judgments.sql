-- The duplication check's AI answers, kept per pair of games and what was measured between them (src/originality-check.ts),
-- so deploying the same game again does not ask the AI the same question twice.
CREATE TABLE IF NOT EXISTS dup_judgments (
  key TEXT PRIMARY KEY,          -- sha256 of both listings, both builds' facts and the measurements
  answer TEXT NOT NULL,          -- JSON: { verdict, p, probabilities, model }
  created_at INTEGER NOT NULL
);

-- The identity index: hashes of each version's normalized title, title skeleton, tagline and a sketch of the names in its
-- code (the smallest name hashes, which games sharing many names tend to share). Looked up by hash, so finding games with
-- the same name or the same characters costs the same however many games are live.
CREATE TABLE IF NOT EXISTS id_index (
  h INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (h, project_id, version)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS id_index_version ON id_index (project_id, version);
