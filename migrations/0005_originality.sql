-- Duplication check: fingerprints of each verified version, compared with other creators' live games before publishing.
CREATE TABLE fingerprints (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  prints TEXT NOT NULL,            -- JSON: winnowed fingerprints of the game's own code (templates and kits removed), smallest first
  files TEXT NOT NULL,             -- JSON: sha of each own code file over 512 bytes
  assets TEXT NOT NULL,            -- JSON: sha of each image, sound, model, font or wasm file over 2 KB
  look TEXT,                       -- JSON: { dhash, palette } of the verification screenshot
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);
-- the candidate index: a sketch of each version's fingerprints and its asset hashes
CREATE TABLE fp_index (h INTEGER NOT NULL, project_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (h, project_id, version)) WITHOUT ROWID;
CREATE INDEX fp_index_project ON fp_index(project_id, version);
-- Workers AI calls per day and purpose, for the daily caps
CREATE TABLE ai_usage (day TEXT NOT NULL, purpose TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, purpose));
