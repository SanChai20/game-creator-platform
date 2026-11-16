-- Fingerprints record which algorithm made them, so a change to the fingerprinting (PRINTS_VERSION in
-- src/originality.js) re-fingerprints live games instead of comparing incompatible prints.
ALTER TABLE fingerprints ADD COLUMN algo INTEGER NOT NULL DEFAULT 1;
