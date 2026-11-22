-- Build skills (the Creator Store). Open Implementation now shares an agent skill: instructions the game's own development
-- agent writes about how the game is built, for other agents that want to build something similar. Never source code.
-- A skill is written for one version of the game; the store always serves the one written for the live version, so a
-- release that goes live without a fresh skill is refused while the skill is shared (src/skills.ts).
CREATE TABLE game_skills (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,                     -- the game version this skill describes
  description TEXT NOT NULL DEFAULT '',         -- one line: what the skill helps an agent build
  content TEXT NOT NULL,                        -- the skill body, Markdown, no code
  written_by TEXT NOT NULL DEFAULT '',          -- the agent (OAuth client) or 'platform'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);

-- A shared skill is free (0) or sold at this price. A free shared skill lowers the game's platform cut; a paid one does not.
ALTER TABLE projects ADD COLUMN skill_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN skill_sales INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN skill_copies INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN skill_views INTEGER NOT NULL DEFAULT 0;

-- Skill sales, kept apart from game sales so each is counted and shown on its own. Same shape as purchases, so refunds,
-- partial refunds and chargebacks follow the same rules (src/earnings.ts). Ledger rows use kind 'skill_sale'.
CREATE TABLE skill_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  provider TEXT NOT NULL,                       -- stripe | admin
  provider_ref TEXT NOT NULL UNIQUE,
  payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'paid',          -- paid | refunded | disputed | dispute_won
  created_at INTEGER NOT NULL,
  refunded_at INTEGER
);
CREATE INDEX skill_purchases_owner ON skill_purchases(owner_id, status);
CREATE INDEX skill_purchases_project ON skill_purchases(project_id, status);
CREATE INDEX skill_purchases_pi ON skill_purchases(payment_intent);
-- one paid purchase of a skill per buyer
CREATE UNIQUE INDEX skill_purchases_once ON skill_purchases(user_id, project_id) WHERE status = 'paid';
