-- A game's store listing follows the platform language (web/src/languages.ts pickListing).
-- listing_lang: the language the project's own listing (title, tagline, description, controls, cover) is written in,
--   as the creator declared it (game_metadata listing_language); NULL means it is worked out from the text.
-- langs: the platform languages the live version is played in (interface or subtitles), comma-separated, recorded when
--   a version goes live (src/mature.ts); NULL until recorded, '' for a game whose languages are not on record.
-- listing_i18n entries can now carry a cover of their own: {"zh": {"title": "…", …, "cover_key": "covers/…"}}.
ALTER TABLE projects ADD COLUMN listing_lang TEXT;
ALTER TABLE projects ADD COLUMN langs TEXT;
