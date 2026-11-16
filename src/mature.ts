// Adult (18+) games on the store. A game is mature when its live version's declared content reaches 18+
// (web/src/gamemeta.ts matureOf). The project row carries the result (age, mature) so every listing can blur the
// cover without reading the version, and the play endpoint asks the player to confirm before signing a session.
import type { Env, Project, Version } from './env';
import { ensureVersionMeta, getVersion } from './projects';
import { matureOf } from '../web/src/gamemeta';

/** The age rating and the adults-only categories of one version. */
export async function matureOfVersion(env: Env, v: Version): Promise<{ age: number | null; mature: string }> {
  const { meta } = await ensureVersionMeta(env, v);
  const m = matureOf(meta.meta.content);
  return { age: meta.rating?.age ?? null, mature: m.categories.join(',') };
}

/** Records the live version's rating on the project. Called when a version goes live (publish and rollback). */
export async function syncMature(env: Env, pid: string, v: Version): Promise<void> {
  const r = await matureOfVersion(env, v);
  await env.DB.prepare('UPDATE projects SET age = ?, mature = ? WHERE id = ?').bind(r.age ?? 0, r.mature, pid).run();
}

/** Live games published before ratings were recorded on the project, a few at a time. Returns how many it filled in. */
export async function backfillMature(env: Env, max = 20): Promise<number> {
  const rows = (await env.DB.prepare("SELECT id, live_version FROM projects WHERE status = 'live' AND live_version IS NOT NULL AND age IS NULL LIMIT ?").bind(max).all<Pick<Project, 'id' | 'live_version'>>()).results;
  for (const r of rows) {
    try { const v = await getVersion(env, r.id, r.live_version!); if (v) await syncMature(env, r.id, v); else await env.DB.prepare('UPDATE projects SET age = 0 WHERE id = ?').bind(r.id).run(); }
    catch (e) { console.error('mature backfill failed', r.id, e); }
  }
  return rows.length;
}

/** The adults-only categories a project row carries ([] for a game for everyone). */
export const matureList = (p: { mature?: string | null }): string[] => String(p.mature || '').split(',').filter(Boolean);

/** The live game's adults-only categories, working them out first for a game whose rating is not recorded yet. */
export async function liveMature(env: Env, p: Project): Promise<string[]> {
  if (p.age == null && p.live_version) {
    const v = await getVersion(env, p.id, p.live_version);
    if (v) { const r = await matureOfVersion(env, v); await env.DB.prepare('UPDATE projects SET age = ?, mature = ? WHERE id = ?').bind(r.age ?? 0, r.mature, p.id).run(); return r.mature.split(',').filter(Boolean); }
  }
  return matureList(p);
}
