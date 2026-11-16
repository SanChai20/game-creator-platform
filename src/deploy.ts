// Deploys a game version as its own Cloudflare Worker (one for preview, one for live per project).
// The Worker is the platform's runtime wrapper + the game's optional server modules; the bundle
// itself stays in R2 and is read through a bucket binding, so switching versions is one API call.
import { AppError, type Env, type Project, type Version } from './env';
import { GAME_WORKER_SOURCE } from './generated/runtime-source';
import { getState, setState } from './settings';
import { hmacHex, now, parseJson, sha256 } from './util';
import { getVersion, verKey } from './projects';

export type GameEnv = 'preview' | 'live';
export const workerName = (pid: string, e: GameEnv) => `gcp-${pid}-${e}`;
export const playKey = (env: Env, pid: string) => hmacHex(env.SESSION_SECRET, 'play:' + pid);

async function cf(env: Env, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<any> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new AppError(503, 'Game deployment is not configured (CF_API_TOKEN / CF_ACCOUNT_ID secrets are missing).', 'not_configured');
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, { method, body, headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, ...headers } });
  const j = await r.json<any>().catch(() => ({}));
  if (!r.ok || j.success === false) throw new AppError(502, `Cloudflare API ${method} ${path.split('?')[0]} failed (${r.status}): ${(j.errors || []).map((e: any) => e.message).join('; ') || 'unknown error'}`, 'deploy_failed');
  return j.result;
}

async function subdomain(env: Env): Promise<string> {
  let sub = await getState<string>(env, 'workers_subdomain', '');
  if (!sub) { sub = (await cf(env, 'GET', '/workers/subdomain')).subdomain; await setState(env, 'workers_subdomain', sub); }
  return sub;
}

export async function gameUrl(env: Env, origin: string, pid: string, e: GameEnv): Promise<string> {
  if (env.DEPLOY_DRIVER === 'local') return `${origin}/__game/${pid}/${e}/`;
  return `https://${workerName(pid, e)}.${await subdomain(env)}.workers.dev/`;
}

/** The bindings a game Worker runs with. Also used to build the env for the local driver. */
export async function gameBindings(env: Env, origin: string, p: Project, v: Version, e: GameEnv): Promise<Record<string, string>> {
  return {
    PREFIX: verKey(p.id, v.n, ''), PLATFORM: origin, GAME_ID: p.id, SLUG: p.slug, TITLE: p.title, VERSION: String(v.n), ENV: e,
    // the game Worker needs the import map and flags, not the compatibility record (bindings are size-limited)
    MANIFEST: (() => { try { const { compat: _c, meta: _m, ...m } = JSON.parse(v.manifest || '{}'); return JSON.stringify(m); } catch { return v.manifest; } })(), PLAY_KEY: await playKey(env, p.id),
  };
}

export async function deployGame(env: Env, origin: string, p: Project, v: Version, e: GameEnv): Promise<string> {
  const url = await gameUrl(env, origin, p.id, e);
  if (env.DEPLOY_DRIVER === 'local') return url;
  const name = workerName(p.id, e);
  const vars = await gameBindings(env, origin, p, v, e);
  const bindings: unknown[] = [{ type: 'r2_bucket', name: 'FILES', bucket_name: env.GAMES_BUCKET }];
  for (const [k, text] of Object.entries(vars)) bindings.push({ type: k === 'PLAY_KEY' ? 'secret_text' : 'plain_text', name: k, text });

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({
    main_module: 'game-worker.js', compatibility_date: '2026-10-01', bindings, tags: ['gcp-game', `gcp-${e}`],
    observability: { enabled: true },
  })], { type: 'application/json' }));
  const mod = (name: string, src: string | ArrayBuffer) => form.set(name, new File([src], name, { type: 'application/javascript+module' }));
  mod('game-worker.js', GAME_WORKER_SOURCE);
  const files = parseJson<{ path: string }[]>(v.files, []).filter((f) => f.path.startsWith('server/') && /\.m?js$/.test(f.path));
  if (!files.some((f) => f.path === 'server/index.js')) mod('server/index.js', 'export default null;\n');
  for (const f of files) {
    const obj = await env.FILES.get(verKey(p.id, v.n, f.path));
    if (obj) mod(f.path, await obj.arrayBuffer());
  }
  await cf(env, 'PUT', `/workers/scripts/${name}`, form);
  await cf(env, 'POST', `/workers/scripts/${name}/subdomain`, JSON.stringify({ enabled: true, previews_enabled: false }), { 'content-type': 'application/json' });
  await env.DB.prepare('INSERT INTO game_workers (project_id, env, version, runtime, origin, deployed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, env) DO UPDATE SET version = excluded.version, runtime = excluded.runtime, origin = excluded.origin, deployed_at = excluded.deployed_at')
    .bind(p.id, e, v.n, await runtimeHash(), origin, now()).run();
  return url;
}

let runtimeSum: string | null = null;
/** Identifies the runtime source this platform build deploys game Workers with. */
export async function runtimeHash(): Promise<string> { return (runtimeSum ??= (await sha256(GAME_WORKER_SOURCE)).slice(0, 16)); }

/** The platform origin an existing game Worker was deployed for, read from its PLATFORM binding (for Workers deployed before game_workers existed). */
async function deployedOrigin(env: Env, name: string): Promise<string | null> {
  try {
    const s = await cf(env, 'GET', `/workers/scripts/${name}/settings`);
    const b = (s?.bindings || []).find((x: any) => x.name === 'PLATFORM' && typeof x.text === 'string');
    return b ? b.text : null;
  } catch (err) { if (err instanceof AppError && /\(404\)/.test(err.message)) return null; throw err; }
}

/** Redeploys, a few at a time, every game Worker that runs an older runtime than this build, with the version it already serves.
    Runs from the scheduled handler, so a runtime fix (such as never serving server code as a file) reaches every game. */
export async function rolloutRuntime(env: Env, max = 8): Promise<{ updated: string[]; skipped: string[]; failed: string[]; remaining: number }> {
  const out = { updated: [] as string[], skipped: [] as string[], failed: [] as string[], remaining: 0 };
  if (env.DEPLOY_DRIVER === 'local' || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return out;
  const rt = await runtimeHash();
  const stale = `FROM projects p CROSS JOIN (SELECT 'live' AS env UNION ALL SELECT 'preview') e
    LEFT JOIN game_workers w ON w.project_id = p.id AND w.env = e.env
    WHERE p.status != 'removed' AND (CASE e.env WHEN 'live' THEN p.status = 'live' AND p.live_version IS NOT NULL ELSE p.preview_version IS NOT NULL END)
      AND (w.runtime IS NULL OR w.runtime != ?1)`;
  const rows = await env.DB.prepare(`SELECT p.id, e.env AS env, CASE e.env WHEN 'live' THEN p.live_version ELSE p.preview_version END AS n, w.origin AS origin ${stale} ORDER BY e.env = 'live' DESC, p.updated_at DESC LIMIT ?2`)
    .bind(rt, max).all<{ id: string; env: GameEnv; n: number; origin: string | null }>();
  for (const r of rows.results) {
    const name = workerName(r.id, r.env);
    try {
      const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(r.id).first<Project>(), v = await getVersion(env, r.id, r.n);
      const origin = r.origin || await deployedOrigin(env, name);
      if (!p || !v || !origin) {
        // no Worker to refresh (never deployed, or deleted): remember that, so the rollout does not keep coming back to it
        await env.DB.prepare('INSERT INTO game_workers (project_id, env, version, runtime, origin, deployed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, env) DO UPDATE SET runtime = excluded.runtime, deployed_at = excluded.deployed_at')
          .bind(r.id, r.env, r.n, rt, origin || '', now()).run();
        out.skipped.push(name); continue;
      }
      await deployGame(env, origin, p, v, r.env);
      out.updated.push(name);
    } catch (err) { console.error('runtime rollout failed', name, err); out.failed.push(name); }
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n ${stale}`).bind(rt).first<{ n: number }>();
  out.remaining = left?.n || 0;
  if (out.updated.length || out.failed.length) console.log('runtime rollout', JSON.stringify(out));
  return out;
}

export async function undeployGame(env: Env, pid: string, e: GameEnv): Promise<void> {
  if (env.DEPLOY_DRIVER === 'local') return;
  try { await cf(env, 'DELETE', `/workers/scripts/${workerName(pid, e)}?force=true`); } catch (err) { if (!(err instanceof AppError) || !/\(404\)/.test(err.message)) throw err; }
}

/** Waits until the deployed Worker answers with the expected version (new hostnames take a little while). */
export async function waitHealthy(env: Env, url: string, version: number, timeoutMs = 150000): Promise<{ ok: boolean; detail: string }> {
  if (env.DEPLOY_DRIVER === 'local') return { ok: true, detail: 'local driver' };
  const start = Date.now();
  let last = '', good = 0;   // three answers in a row, so one lucky edge location is not mistaken for a finished rollout
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url + '__gcp/health', { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const j = await r.json<{ version?: number }>().catch(() => ({} as { version?: number })); if (j.version === version) { if (++good >= 3) return { ok: true, detail: `healthy after ${Math.round((Date.now() - start) / 1000)}s` }; await new Promise((r) => setTimeout(r, 1200)); continue; } good = 0; last = `serving version ${j.version}`; }
      else { good = 0; last = `HTTP ${r.status}`; }
    } catch (e) { last = String((e as Error).message || e); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { ok: false, detail: `The game Worker did not become healthy within ${Math.round(timeoutMs / 1000)}s (${last}).` };
}
