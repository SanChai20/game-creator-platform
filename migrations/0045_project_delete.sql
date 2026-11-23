-- A creator can delete a project of their own (MCP delete_project, the console's Delete project). It is a soft delete:
-- the project becomes 'removed' with deleted_at set, stops counting toward the project limit and disappears from the
-- creator's lists. Players' data is purged REMOVED_DATA_DAYS later (src/cleanup.ts); until then a platform admin can restore it.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
