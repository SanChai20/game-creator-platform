-- The store listing (title, tagline, description, controls) translated into the platform's languages, set by the creator.
-- JSON: {"ja": {"title": "…", "tagline": "…", "description": "…", "controls": "…"}, …}. The original listing stays in the
-- projects columns; the store page shows a translation when the viewer's language has one.
ALTER TABLE projects ADD COLUMN listing_i18n TEXT NOT NULL DEFAULT '{}';
