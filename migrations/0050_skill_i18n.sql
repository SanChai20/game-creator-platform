-- Multi-language build skills: base description and content are always canonical English (en).
-- i18n stores a JSON object mapping other platform language codes ("zh", "zh-TW", "ja", "ko", "es")
-- to { "description": "...", "content": "..." }.
ALTER TABLE game_skills ADD COLUMN i18n TEXT NOT NULL DEFAULT '{}';
