-- Coming soon pages and wishlists (src/wishlist.js). A game that has never been released can be announced: its page is
-- public with no Play button, players wishlist it, and its first release is news for everyone who did.
ALTER TABLE projects ADD COLUMN coming_soon_at INTEGER;   -- when the creator announced it; null when it is not announced
ALTER TABLE projects ADD COLUMN release_note TEXT;        -- the creator's own words for when: "Spring 2027", "Soon"
CREATE TABLE IF NOT EXISTS wishlists (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS wishlists_project ON wishlists(project_id, created_at);
CREATE INDEX IF NOT EXISTS projects_coming_soon ON projects(coming_soon_at) WHERE coming_soon_at IS NOT NULL;
