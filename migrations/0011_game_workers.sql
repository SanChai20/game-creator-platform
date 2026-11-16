-- Which runtime each deployed game Worker runs. When the platform's game runtime changes (src/runtime/game-worker.js),
-- the scheduled rollout redeploys every Worker whose runtime differs, so a fix reaches games that were deployed before it.
CREATE TABLE IF NOT EXISTS game_workers (
  project_id TEXT NOT NULL,
  env TEXT NOT NULL,              -- 'preview' | 'live'
  version INTEGER NOT NULL,       -- the version the Worker serves
  runtime TEXT NOT NULL,          -- sha256 of the runtime source it was deployed with
  origin TEXT NOT NULL,           -- the platform origin it was deployed for (PLATFORM binding)
  deployed_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, env)
);
