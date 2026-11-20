// Keeps hosting within its limits (security review, finding 3). Every project can hold two game Workers and every
// version keeps a full copy of its files, and a standard Workers account allows 500 Workers in all. Run from the daily
// scheduled handler, a few at a time.
//   - A preview Worker that nobody opened and nothing deployed for IDLE_DAYS is deleted. game_workers.idle_at marks it,
//     so the runtime rollout leaves it alone, and the next preview launch deploys it again (ensurePreview).
//   - The files of old versions are deleted: everything but the live and preview versions, the newest KEEP_VERSIONS,
//     and versions that were live in the last LIVE_KEEP_DAYS (what a rollback may go back to). versions.purged_at marks
//     them, and publishing or rolling back to one is refused with a clear message.
import type { Env, Project } from './env';
import { deployGame, undeployGame, waitHealthy } from './deploy';
import { getVersion } from './projects';
import { now } from './util';

export const IDLE_DAYS = 14, KEEP_VERSIONS = 5, VERSION_MIN_AGE_DAYS = 30, LIVE_KEEP_DAYS = 90;
const DAY = 86400000;

export async function retireIdlePreviews(env: Env, max = 20): Promise<string[]> {
  const t = now(), before = t - IDLE_DAYS * DAY;
  const rows = await env.DB.prepare(`SELECT w.project_id FROM game_workers w
    WHERE w.env = 'preview' AND w.idle_at IS NULL AND w.deployed_at < ?1
      AND NOT EXISTS (SELECT 1 FROM plays pl WHERE pl.project_id = w.project_id AND pl.env = 'preview' AND pl.kind != 'verify' AND pl.started_at >= ?1)
    LIMIT ?2`).bind(before, max).all<{ project_id: string }>();
  const out: string[] = [];
  for (const r of rows.results) {
    try {
      await undeployGame(env, r.project_id, 'preview');
      await env.DB.prepare("UPDATE game_workers SET idle_at = ? WHERE project_id = ? AND env = 'preview'").bind(t, r.project_id).run();
      out.push(r.project_id);
    } catch (e) { console.error('retiring idle preview failed', r.project_id, e); }
  }
  if (out.length) console.log(JSON.stringify({ idle_previews_retired: out }));
  return out;
}

/** Before a preview is opened: a preview Worker removed for being idle is deployed again first. */
export async function ensurePreview(env: Env, origin: string, p: Project): Promise<void> {
  if (!p.preview_version) return;
  const row = await env.DB.prepare("SELECT idle_at FROM game_workers WHERE project_id = ? AND env = 'preview'").bind(p.id).first<{ idle_at: number | null }>().catch(() => null);
  if (!row?.idle_at) return;
  const v = await getVersion(env, p.id, p.preview_version);
  if (!v) return;
  const url = await deployGame(env, origin, p, v, 'preview');
  await env.DB.prepare("UPDATE game_workers SET idle_at = NULL WHERE project_id = ? AND env = 'preview'").bind(p.id).run();
  await waitHealthy(env, url, v.n, 30000);
}

export async function purgeOldVersions(env: Env, max = 20): Promise<string[]> {
  const t = now();
  const rows = await env.DB.prepare(`SELECT v.project_id, v.n FROM versions v JOIN projects p ON p.id = v.project_id
    WHERE v.purged_at IS NULL AND v.created_at < ?1
      AND v.n != COALESCE(p.live_version, 0) AND v.n != COALESCE(p.preview_version, 0)
      AND v.n <= p.next_version - 1 - ?2
      AND (v.published_at IS NULL OR v.published_at < ?3)
      AND v.status NOT IN ('queued', 'deploying', 'verifying') AND (v.review IS NULL OR v.review != 'pending')
    ORDER BY v.created_at LIMIT ?4`).bind(t - VERSION_MIN_AGE_DAYS * DAY, KEEP_VERSIONS, t - LIVE_KEEP_DAYS * DAY, max).all<{ project_id: string; n: number }>();
  const out: string[] = [];
  for (const r of rows.results) {
    try {
      const prefix = `v/${r.project_id}/${r.n}/`;
      let cursor: string | undefined;
      do {
        const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
        if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      await env.DB.prepare('UPDATE versions SET purged_at = ? WHERE project_id = ? AND n = ?').bind(t, r.project_id, r.n).run();
      out.push(`${r.project_id}/${r.n}`);
    } catch (e) { console.error('purging version failed', r.project_id, r.n, e); }
  }
  if (out.length) console.log(JSON.stringify({ versions_purged: out }));
  return out;
}

export const REMOVED_DATA_DAYS = 30;
/** Players' data of games removed from the platform more than REMOVED_DATA_DAYS ago (security review, finding 12; the
 *  privacy policy says so). Until then an admin can still restore the game with its players' progress. Purchases stay. */
export async function purgeRemovedGameData(env: Env, max = 20): Promise<string[]> {
  const t = now();
  const rows = await env.DB.prepare(`SELECT id FROM projects WHERE status = 'removed' AND updated_at < ?1
    AND (data_purged_at IS NULL OR data_purged_at < updated_at) LIMIT ?2`).bind(t - REMOVED_DATA_DAYS * DAY, max).all<{ id: string }>();
  for (const { id } of rows.results) {
    // live data is scoped "<id>", preview data "<id>:preview"
    await env.DB.batch([
      ...['saves', 'player_stats', 'player_games', 'scores', 'match_ratings'].map((tb) => env.DB.prepare(`DELETE FROM ${tb} WHERE project_id IN (?1, ?1 || ':preview')`).bind(id)),
      env.DB.prepare('DELETE FROM library_games WHERE project_id = ?').bind(id),
      env.DB.prepare('UPDATE projects SET data_purged_at = ? WHERE id = ?').bind(t, id),
    ]);
  }
  return rows.results.map((r) => r.id);
}

/** Runs independent statements one by one; every one is tried, and the job fails afterwards if any of them did. */
export async function eachStmt(stmts: D1PreparedStatement[]): Promise<number> {
  const failed: string[] = [];
  let changes = 0;
  for (const st of stmts) {
    try { changes += (await st.run()).meta.changes || 0; }
    catch (e) { failed.push(String((e as Error).message || e).slice(0, 200)); }
  }
  if (failed.length) throw new Error(`${failed.length} of ${stmts.length} cleanup statements failed: ${failed.join('; ')}`);
  return changes;
}
