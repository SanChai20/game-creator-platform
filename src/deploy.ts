// Deploys a game version as its own Worker (one for preview, one for live per project). The Worker is the platform's
// runtime wrapper + the game's optional server modules; the bundle itself stays in R2 and is read through a bucket
// binding, so switching versions is one API call. Where the Worker lives (a standard Worker today, a user Worker in a
// Workers for Platforms dispatch namespace later) is decided by src/hosting.ts from the configuration; this file only
// talks to "a host". See docs/workers-for-platforms.md.
import { AppError, type Env, type Project, type Version } from './env';
import { GAME_WORKER_SOURCE } from './generated/runtime-source';
import { getSettings, getState, setState } from './settings';
import { hmacHex, now, parseJson, sha256 } from './util';
import { getVersion, verKey } from './projects';
import {
  GAME_COMPAT_DATE, GAME_COMPAT_FLAGS, GAME_MAIN_MODULE, RETIRE_AFTER_MS, gameLimits, gameUrlFor, hostId, hostKind,
  matchGameRequest, metadataLimits, parseHostId, scriptBindings, scriptMetadata, scriptName, scriptsPath, scriptTags, type GameEnv, type HostRef,
} from './hosting';
import { gameFetch } from './dispatch';

export type { GameEnv } from './hosting';
export const workerName = scriptName;
export const playKey = (env: Env, pid: string) => hmacHex(env.SESSION_SECRET, 'play:' + pid);

async function cfFetch(env: Env, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<any> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new AppError(503, 'Game deployment is not configured (CF_API_TOKEN / CF_ACCOUNT_ID secrets are missing).', 'not_configured');
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, body, headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, ...headers } });
  const j = await r.json<any>().catch(() => ({}));
  if (!r.ok || j.success === false) throw new AppError(502, `Cloudflare API ${method} ${path.split('?')[0]} failed (${r.status}): ${(j.errors || []).map((e: any) => `${e.message}${e.code ? ` [${e.code}]` : ''}`).join('; ') || 'unknown error'}`, 'deploy_failed');
  return j.result;
}
const cf = (env: Env, method: string, path: string, body?: BodyInit, headers?: Record<string, string>) => cfFetch(env, method, `/accounts/${env.CF_ACCOUNT_ID}${path}`, body, headers);
const JSON_HEADERS = { 'content-type': 'application/json' };
const is404 = (err: unknown) => err instanceof AppError && /\(404\)/.test(err.message);

async function subdomain(env: Env): Promise<string> {
  let sub = await getState<string>(env, 'workers_subdomain', '');
  if (!sub) { sub = (await cf(env, 'GET', '/workers/subdomain')).subdomain; await setState(env, 'workers_subdomain', sub); }
  return sub;
}

// ----- hosts -------------------------------------------------------------------------------------------------------
interface Host extends HostRef { id: string; put(script: string, form: FormData): Promise<void>; remove(script: string): Promise<void>; settings(script: string): Promise<any | null> }

/** Standard Workers on per-script routes (<script>.<GAME_HOST>/*) instead of workers.dev, so the game addresses are
    already the ones the dispatch Worker will answer on after the move: players keep the same origin (and its storage). */
async function ensureRoute(env: Env, routeHost: string, script: string): Promise<void> {
  try { await cfFetch(env, 'POST', `/zones/${env.GAME_ZONE_ID}/workers/routes`, JSON.stringify({ pattern: `${script}.${routeHost}/*`, script }), JSON_HEADERS); }
  catch (err) { if (!(err instanceof AppError && /already exists|duplicate|10020/i.test(err.message))) throw err; }
}
async function removeRoute(env: Env, routeHost: string, script: string): Promise<void> {
  if (!env.GAME_ZONE_ID) return;
  const routes = await cfFetch(env, 'GET', `/zones/${env.GAME_ZONE_ID}/workers/routes`) as { id: string; pattern: string }[];
  for (const r of routes || []) if (r.pattern === `${script}.${routeHost}/*`) await cfFetch(env, 'DELETE', `/zones/${env.GAME_ZONE_ID}/workers/routes/${r.id}`);
}

function host(env: Env, id = hostId(env)): Host {
  const h = parseHostId(id);
  if (h.kind === 'local') return { ...h, id, put: async () => {}, remove: async () => {}, settings: async () => null };
  const base = scriptsPath(h);
  return {
    ...h, id,
    async put(script, form) {
      await cf(env, 'PUT', `${base}/${script}`, form);
      if (h.kind !== 'workers') return;   // a user Worker has no hostname of its own: the dispatch Worker reaches it
      if (h.routeHost) await ensureRoute(env, h.routeHost, script);
      else await cf(env, 'POST', `${base}/${script}/subdomain`, JSON.stringify({ enabled: true, previews_enabled: false }), JSON_HEADERS);
    },
    async remove(script) {
      if (h.kind === 'workers' && h.routeHost) await removeRoute(env, h.routeHost, script).catch((e) => console.error('route removal failed', script, e));
      try { await cf(env, 'DELETE', `${base}/${script}?force=true`); } catch (err) { if (!is404(err)) throw err; }
    },
    async settings(script) {
      try { return await cf(env, 'GET', `${base}/${script}/settings`); } catch (err) { if (is404(err)) return null; throw err; }
    },
  };
}

async function urlIn(env: Env, id: string, script: string, origin: string): Promise<string> {
  const h = parseHostId(id);
  return gameUrlFor(env, h, script, { origin, subdomain: h.kind === 'workers' && !h.routeHost ? await subdomain(env) : undefined });
}

type Row = { host: string | null; script: string | null; retired_host: string | null; retired_at: number | null; origin: string | null };
async function deployedRow(env: Env, pid: string, e: GameEnv): Promise<Row | null> {
  try { return await env.DB.prepare('SELECT host, script, retired_host, retired_at, origin FROM game_workers WHERE project_id = ? AND env = ?').bind(pid, e).first<Row>(); }
  catch { return null; }   // before migration 0012
}

/** The address a game is played at: where its Worker is now. While games move to another host, one that has not
    been redeployed yet keeps its old address until the rollout reaches it. */
export async function gameUrl(env: Env, origin: string, pid: string, e: GameEnv): Promise<string> {
  const script = scriptName(pid, e);
  if (hostKind(env) === 'local') return urlIn(env, 'local', script, origin);
  const row = await deployedRow(env, pid, e);
  return urlIn(env, row?.host || hostId(env), script, origin);
}

/** The bindings a game Worker runs with. Also used to build the env for the local driver. */
export async function gameBindings(env: Env, origin: string, p: Project, v: Version, e: GameEnv): Promise<Record<string, string>> {
  return {
    PREFIX: verKey(p.id, v.n, ''), PLATFORM: origin, GAME_ID: p.id, SLUG: p.slug, TITLE: p.title, VERSION: String(v.n), ENV: e,
    // the game Worker needs the import map and flags, not the compatibility record (bindings are size-limited)
    MANIFEST: (() => { try { const { compat: _c, meta: _m, ...m } = JSON.parse(v.manifest || '{}'); return JSON.stringify(m); } catch { return v.manifest; } })(), PLAY_KEY: await playKey(env, p.id),
  };
}

let runtimeSum: string | null = null;
/** Identifies the runtime this platform build deploys game Workers with: the source, compatibility date and flags. */
export async function runtimeHash(): Promise<string> {
  return (runtimeSum ??= (await sha256(JSON.stringify([GAME_WORKER_SOURCE, GAME_COMPAT_DATE, GAME_COMPAT_FLAGS]))).slice(0, 16));
}
/** What game_workers.runtime records: the runtime, plus the limits when they are baked into the script (standard
    Workers). Changing a limit in the admin settings then makes the rollout redeploy every game with it. */
async function fingerprint(env: Env): Promise<string> {
  const rt = await runtimeHash();
  if (hostKind(env) !== 'workers') return rt;   // a dispatch namespace takes the limits per request
  const l = metadataLimits(gameLimits(await getSettings(env)));
  return l ? `${rt}:${l.cpu_ms || 0}/${l.subrequests || 0}` : rt;
}

export async function deployGame(env: Env, origin: string, p: Project, v: Version, e: GameEnv): Promise<string> {
  const script = scriptName(p.id, e), kind = hostKind(env);
  if (kind === 'local') return urlIn(env, 'local', script, origin);
  const h = host(env);
  const files = parseJson<{ path: string }[]>(v.files, []).filter((f) => f.path.startsWith('server/') && /\.m?js$/.test(f.path));
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(scriptMetadata(kind, {
    bindings: scriptBindings(await gameBindings(env, origin, p, v, e), env.GAMES_BUCKET),
    tags: scriptTags({ pid: p.id, owner: p.owner_id, env: e, server: files.length > 0 }),
    limits: gameLimits(await getSettings(env)),
  }))], { type: 'application/json' }));
  const mod = (name: string, src: string | ArrayBuffer) => form.set(name, new File([src], name, { type: 'application/javascript+module' }));
  mod(GAME_MAIN_MODULE, GAME_WORKER_SOURCE);
  if (!files.some((f) => f.path === 'server/index.js')) mod('server/index.js', 'export default null;\n');
  for (const f of files) {
    const obj = await env.FILES.get(verKey(p.id, v.n, f.path));
    if (obj) mod(f.path, await obj.arrayBuffer());
  }
  await h.put(script, form);
  const url = await urlIn(env, h.id, script, origin);

  // Moved from another host (the Workers for Platforms migration): retire the old copy. If the address is the same
  // (per-script routes on GAME_HOST), the old route would shadow the new host, so it goes now; sessions carry on, the
  // play key is the same. Otherwise players keep using the old address for up to 6 hours, so it goes later.
  const prev = await deployedRow(env, p.id, e);
  let retiredHost = prev?.retired_host || null, retiredAt = prev?.retired_at || null;
  if (prev?.host && prev.host !== h.id) {
    const old = parseHostId(prev.host);
    if (old.kind === 'workers' && h.kind === 'workers') {
      // the same standard Worker, now on a route (or back on workers.dev): only an old route is left to drop
      if (old.routeHost) await removeRoute(env, old.routeHost, script).catch((err) => console.error('route removal failed', script, err));
    } else {
      const oldUrl = await urlIn(env, prev.host, script, origin).catch(() => null);
      if (oldUrl === url) await host(env, prev.host).remove(script).catch((err) => console.error('retiring old game Worker failed', script, err));
      else { retiredHost = prev.host; retiredAt = now(); }
    }
  }
  await env.DB.prepare(`INSERT INTO game_workers (project_id, env, version, runtime, origin, deployed_at, host, script, retired_host, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, env) DO UPDATE SET version = excluded.version, runtime = excluded.runtime, origin = excluded.origin, deployed_at = excluded.deployed_at,
      host = excluded.host, script = excluded.script, retired_host = excluded.retired_host, retired_at = excluded.retired_at`)
    .bind(p.id, e, v.n, await fingerprint(env), origin, now(), h.id, script, retiredHost, retiredAt).run();
  return url;
}

/** The platform origin an existing game Worker was deployed for, read from its PLATFORM binding (for Workers deployed before game_workers existed). */
async function deployedOrigin(env: Env, id: string, script: string): Promise<string | null> {
  const s = await host(env, id).settings(script);
  const b = (s?.bindings || []).find((x: any) => x.name === 'PLATFORM' && typeof x.text === 'string');
  return b ? b.text : null;
}

/** Brings every game Worker up to this build, a few at a time, with the version it already serves: one that runs an
    older runtime or older limits, or that lives in another host than the configured one (which is how games move to
    a dispatch namespace). Then deletes the old copies of moved games once their sessions are over. Runs from the
    scheduled handler, so a runtime fix (such as never serving server code as a file) reaches every game. */
export async function rolloutRuntime(env: Env, max = 8): Promise<{ updated: string[]; skipped: string[]; failed: string[]; retired: string[]; remaining: number }> {
  const out = { updated: [] as string[], skipped: [] as string[], failed: [] as string[], retired: [] as string[], remaining: 0 };
  if (hostKind(env) === 'local' || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return out;
  const fp = await fingerprint(env), hid = hostId(env);
  const stale = `FROM projects p CROSS JOIN (SELECT 'live' AS env UNION ALL SELECT 'preview') e
    LEFT JOIN game_workers w ON w.project_id = p.id AND w.env = e.env
    WHERE p.status != 'removed' AND (CASE e.env WHEN 'live' THEN p.status = 'live' AND p.live_version IS NOT NULL ELSE p.preview_version IS NOT NULL END)
      AND (w.runtime IS NULL OR w.runtime != ?1 OR w.host IS NULL OR w.host != ?2)`;
  const rows = await env.DB.prepare(`SELECT p.id, e.env AS env, CASE e.env WHEN 'live' THEN p.live_version ELSE p.preview_version END AS n, w.origin AS origin, w.host AS host ${stale} ORDER BY e.env = 'live' DESC, p.updated_at DESC LIMIT ?3`)
    .bind(fp, hid, max).all<{ id: string; env: GameEnv; n: number; origin: string | null; host: string | null }>();
  for (const r of rows.results) {
    const name = scriptName(r.id, r.env);
    try {
      const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(r.id).first<Project>(), v = await getVersion(env, r.id, r.n);
      const origin = r.origin || await deployedOrigin(env, r.host || 'workers', name);
      if (!p || !v || !origin) {
        // no Worker to refresh (never deployed, or deleted): remember that, so the rollout does not keep coming back to it
        await env.DB.prepare('INSERT INTO game_workers (project_id, env, version, runtime, origin, deployed_at, host, script) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, env) DO UPDATE SET runtime = excluded.runtime, deployed_at = excluded.deployed_at, host = excluded.host, script = excluded.script')
          .bind(r.id, r.env, r.n, fp, origin || '', now(), hid, name).run();
        out.skipped.push(name); continue;
      }
      await deployGame(env, origin, p, v, r.env);
      out.updated.push(name);
    } catch (err) { console.error('runtime rollout failed', name, err); out.failed.push(name); }
  }
  // old copies of games that moved host, once nobody can still be playing on them
  const old = await env.DB.prepare('SELECT project_id, env, retired_host FROM game_workers WHERE retired_host IS NOT NULL AND retired_at < ? LIMIT ?')
    .bind(now() - RETIRE_AFTER_MS, max).all<{ project_id: string; env: GameEnv; retired_host: string }>().catch(() => ({ results: [] as { project_id: string; env: GameEnv; retired_host: string }[] }));
  for (const r of old.results) {
    const name = scriptName(r.project_id, r.env);
    try {
      if (r.retired_host !== hid) await host(env, r.retired_host).remove(name);
      await env.DB.prepare('UPDATE game_workers SET retired_host = NULL, retired_at = NULL WHERE project_id = ? AND env = ?').bind(r.project_id, r.env).run();
      out.retired.push(`${r.retired_host}/${name}`);
    } catch (err) { console.error('retiring old game Worker failed', name, err); out.failed.push(name); }
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n ${stale}`).bind(fp, hid).first<{ n: number }>();
  out.remaining = left?.n || 0;
  if (out.updated.length || out.failed.length || out.retired.length) console.log('runtime rollout', JSON.stringify(out));
  return out;
}

/** Deletes a game's Worker wherever it lives: the configured host, the host it was last deployed to, and an old copy
    still waiting to be retired. */
export async function undeployGame(env: Env, pid: string, e: GameEnv): Promise<void> {
  if (hostKind(env) === 'local') return;
  const script = scriptName(pid, e), row = await deployedRow(env, pid, e);
  const ids = new Set([hostId(env), row?.host, row?.retired_host].filter((x): x is string => !!x && x !== 'local'));
  for (const id of ids) await host(env, id).remove(script);
  if (row) await env.DB.prepare('UPDATE game_workers SET retired_host = NULL, retired_at = NULL WHERE project_id = ? AND env = ?').bind(pid, e).run();
}

/** Fetches a game URL from the platform: through the DISPATCHER binding when it is on the dispatch host, so health
    checks never depend on one Worker reaching another over HTTP. */
async function fetchGame(env: Env, url: string, init?: RequestInit): Promise<Response> {
  const route = hostKind(env) === 'dispatch' ? matchGameRequest(env, new URL(url)) : null;
  return gameFetch(url, route, route && env.DISPATCHER ? env.DISPATCHER : null, env, await getSettings(env), env.PUBLIC_ORIGIN || '', init);
}

/** Waits until the deployed Worker answers with the expected version (new hostnames take a little while). */
export async function waitHealthy(env: Env, url: string, version: number, timeoutMs = 150000): Promise<{ ok: boolean; detail: string }> {
  if (hostKind(env) === 'local') return { ok: true, detail: 'local driver' };
  const start = Date.now();
  let last = '', good = 0;   // three answers in a row, so one lucky edge location is not mistaken for a finished rollout
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetchGame(env, url + '__gcp/health', { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const j = await r.json<{ version?: number }>().catch(() => ({} as { version?: number })); if (j.version === version) { if (++good >= 3) return { ok: true, detail: `healthy after ${Math.round((Date.now() - start) / 1000)}s` }; await new Promise((r) => setTimeout(r, 1200)); continue; } good = 0; last = `serving version ${j.version}`; }
      else { good = 0; last = `HTTP ${r.status}`; }
    } catch (e) { last = String((e as Error).message || e); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { ok: false, detail: `The game Worker did not become healthy within ${Math.round(timeoutMs / 1000)}s (${last}).` };
}
