// Switching a game's live version. Kept apart from the pipeline Durable Object so it can be tested on its own.
import type { Env, Project, Version } from './env';
import { now } from './util';
import { reviveStmts, outcomeOf } from './store-quality';

export type Health = { ok: boolean; detail: string };
export type WaitHealthy = (env: Env, url: string, version: number) => Promise<Health>;

/** Makes version v the live one and confirms the game answers with it.

    A game with its own Worker already serves v once it is deployed, so its health check comes first and the switch
    only happens after it passes. A game on the shared host serves whatever projects.live_version names, so it could
    never answer with v before the switch: there the switch comes first, the health check confirms it, and a game
    that does not answer is put back exactly as it was. beforeSwitch runs right before the switch in both cases. */
export async function switchLive(env: Env, p: Project, v: Version, url: string, shared: boolean, wait: WaitHealthy, beforeSwitch: () => Promise<void> = async () => {}): Promise<Health> {
  const t = now();
  const set = () => env.DB.batch([
    env.DB.prepare("UPDATE projects SET status = 'live', live_version = ?, published_at = COALESCE(published_at, ?), cover_key = COALESCE(cover_key, ?), updated_at = ? WHERE id = ? AND status != 'removed'").bind(v.n, t, v.screenshot_key, t, p.id),
    env.DB.prepare('UPDATE versions SET published_at = ? WHERE project_id = ? AND n = ?').bind(t, p.id, v.n),
    // whether this version reports a score or an ending: optional, a small ranking lift (src/store-quality.ts)
    env.DB.prepare('UPDATE projects SET eng_outcome = ? WHERE id = ?').bind(outcomeOf(v.report), p.id),
    // a game hidden by player reports comes back with a new version (src/store-quality.ts)
    ...(v.n !== p.live_version ? reviveStmts(env.DB, p.id, v.n, t) : []),
  ]);
  if (!shared) {
    const health = await wait(env, url, v.n);
    if (health.ok) { await beforeSwitch(); await set(); }
    return health;
  }
  await beforeSwitch();
  await set();
  const health = await wait(env, url, v.n);
  if (!health.ok) {
    // only if nothing else changed the live version meanwhile (a rollback or another publish wins)
    await env.DB.batch([
      env.DB.prepare('UPDATE projects SET status = ?, live_version = ?, published_at = ?, cover_key = ?, updated_at = ? WHERE id = ? AND live_version = ? AND status = \'live\'')
        .bind(p.status, p.live_version, p.published_at, p.cover_key, now(), p.id, v.n),
      env.DB.prepare('UPDATE projects SET eng_outcome = ? WHERE id = ? AND live_version = ?').bind((p as { eng_outcome?: number }).eng_outcome ?? 0, p.id, p.live_version),
      env.DB.prepare('UPDATE versions SET published_at = ? WHERE project_id = ? AND n = ? AND published_at = ?').bind(v.published_at, p.id, v.n, t),
    ]);
  }
  return health;
}
