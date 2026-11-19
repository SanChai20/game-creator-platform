-- Creator feedback the agent has read stays for a day before it is deleted, so an agent whose answer never arrived (a
-- dropped connection, a client that refused the pictures) can read it again (creator_feedback with recent: true).
-- taken_at: when creator_feedback returned the item (NULL while it waits in the queue).
ALTER TABLE feedback ADD COLUMN taken_at INTEGER;
CREATE INDEX IF NOT EXISTS feedback_taken ON feedback (project_id, taken_at);
