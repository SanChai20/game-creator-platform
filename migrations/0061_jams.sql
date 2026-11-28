-- Game jams and festivals (src/jams.js). A jam has a theme, a window for entries and then a window for votes on the
-- criteria its host chose; a festival is a showcase of live and coming soon games for a few days, with no votes.
CREATE TABLE IF NOT EXISTS jams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'jam',              -- jam | festival
  title TEXT NOT NULL,
  theme TEXT,                                    -- a jam's theme: shown to everyone but the host once it starts
  description TEXT,
  criteria TEXT NOT NULL DEFAULT '[]',           -- JSON: the names voters score 1 to 5 (jams only)
  new_only INTEGER NOT NULL DEFAULT 1,           -- jams: only games created after the jam started
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,                      -- entries close (a festival ends)
  voting_ends_at INTEGER,                        -- jams: votes close and results show
  featured INTEGER NOT NULL DEFAULT 0,           -- shown on the store's home page (platform-hosted)
  status TEXT NOT NULL DEFAULT 'active',         -- active | cancelled
  noticed TEXT NOT NULL DEFAULT '',              -- the phases entrants were already told about: 'voting', 'voting,results'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jams_time ON jams(status, ends_at);
CREATE INDEX IF NOT EXISTS jams_host ON jams(host_id);
CREATE TABLE IF NOT EXISTS jam_entries (
  jam_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,                         -- who entered it (the game's owner)
  version INTEGER,                               -- the live version when it was entered
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (jam_id, project_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS jam_entries_project ON jam_entries(project_id);
CREATE TABLE IF NOT EXISTS jam_votes (
  jam_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  score INTEGER NOT NULL,                        -- 1 to 5
  at INTEGER NOT NULL,
  PRIMARY KEY (jam_id, project_id, voter_id, criterion)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS jam_votes_voter ON jam_votes(voter_id);
