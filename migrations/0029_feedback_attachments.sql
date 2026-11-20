-- Creator feedback can carry the creator's own pictures (design mockups, references) beside the annotated screenshot,
-- each with its own marks. attachments: JSON list of { key (R2), type, bytes, width, height, marks, name }. bytes on the
-- row is now every picture of the item together.
ALTER TABLE feedback ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
