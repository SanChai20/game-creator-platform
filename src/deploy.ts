// Deploys a game version as its own Cloudflare Worker (one for preview, one for live per project).
// The Worker is the platform's runtime wrapper + the game's optional server modules; the bundle
// itself stays in R2 and is read through a bucket binding, so switching versions is one API call.
import { AppError, type Env, type Project, type Version } from './env';
import { GAME_WORKER_SOURCE } from './generated/runtime-source';
import { verKey } from './projects';
import { getState, setState } from './settings';
import { hmacHex, parseJson } from './util';

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
    MANIFEST: v.manifest, PLAY_KEY: await playKey(env, p.id),
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
  return url;
}

export async function undeployGame(env: Env, pid: string, e: GameEnv): Promise<void> {
  if (env.DEPLOY_DRIVER === 'local') return;
  try { await cf(env, 'DELETE', `/workers/scripts/${workerName(pid, e)}?force=true`); } catch (err) { if (!(err instanceof AppError) || !/\(404\)/.test(err.message)) throw err; }
}

/** Waits until the deployed Worker answers with the expected version (new hostnames take a little while). */
export async function waitHealthy(env: Env, url: string, version: number, timeoutMs = 150000): Promise<{ ok: boolean; detail: string }> {
  if (env.DEPLOY_DRIVER === 'local') return { ok: true, detail: 'local driver' };
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url + '__gcp/health', { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const j = await r.json<{ version?: number }>().catch(() => ({} as { version?: number })); if (j.version === version) return { ok: true, detail: `healthy after ${Math.round((Date.now() - start) / 1000)}s` }; last = `serving version ${j.version}`; }
      else last = `HTTP ${r.status}`;
    } catch (e) { last = String((e as Error).message || e); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { ok: false, detail: `The game Worker did not become healthy within ${Math.round(timeoutMs / 1000)}s (${last}).` };
}
