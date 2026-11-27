-- Store each build skill translation in its own row so large multi-language skills stay well within D1 row and
-- statement limits, concurrent per-language writes from MCP agents never overwrite each other, and store queries
-- only transfer the language(s) they need.
CREATE TABLE IF NOT EXISTS game_skill_i18n (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  lang TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version, lang)
);
CREATE INDEX IF NOT EXISTS game_skill_i18n_ver ON game_skill_i18n (project_id, version);
