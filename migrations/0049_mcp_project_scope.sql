-- Project-scoped MCP authorization for device sign-in.
-- NULL means access to all projects in the account (including new ones);
-- a JSON array of project IDs restricts the issued OAuth grant to only those projects.
ALTER TABLE device_codes ADD COLUMN project_ids TEXT;
