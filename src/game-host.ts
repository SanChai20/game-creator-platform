// The shared game host (DEPLOY_DRIVER "shared"). Instead of one standard Worker per game and environment, the platform
// Worker answers on the wildcard route *.<GAME_HOST>/* and serves every game itself, so the number of games is not
// bounded by the account's Worker scripts or the zone's routes. See docs/shared-game-host.md.
//
// A game is served by the same runtime its own Worker ran (src/runtime/game-worker.js), so the play-token gate, the
// /~t/<token>/ paths that Safari needs, the injected SDK and the headers are unchanged:
//   - pages and files run the runtime in-process with a FILES binding. No creator code runs in this isolate (the game's
//     client code runs in the player's browser), so the bucket binding never reaches it;
//   - /api/* of a game with server code (server/index.js) runs in a Dynamic Worker loaded from the runtime and the
//     game's own server/ and shared/ modules. That isolate gets exactly the env a game Worker had (plain strings and the
//     two keys derived for this game alone), never this Worker's bindings, and every fetch() it makes goes through
//     GameOutbound (src/index.ts), which applies the admin's blocked hosts and answers platform calls in-process;
//   - games with server-run matches (server/match.js) keep a standard Worker on a per-script route (src/deploy.ts), which
//     is more specific than the wildcard, so their requests never get here while that Worker exists.
import type { Env, Project, Version } from './env';
import { gameBindings, runtimeHash } from './deploy';
import { dispatchGame, type GameRoute, type Namespace } from './dispatch';
import { GAME_COMPAT_DATE, GAME_COMPAT_FLAGS, GAME_MAIN_MODULE, outboundParams, type GameMatch, type OutboundParams } from './hosting';
import { getProject, getVersion, verKey } from './projects';
import { getSettings, type Settings } from './settings';
import { parseJson, sha256 } from './util';
import { GAME_INTRINSICS_SOURCE, GAME_MATCH_CORE_SOURCE, GAME_WORKER_SOURCE } from './generated/runtime-source';
// @ts-ignore plain JS module
import { handle as handleGame } from './runtime/game-worker.js';

/** How long one isolate trusts what it read about a game (its current version and that version's bindings). A deploy
    or a rollback reaches players within this time; the health check after a deploy waits for it. */
export const GAME_CACHE_MS = 10_000;

export interface HostedGame { p: Project; v: Version; vars: Record<string, string>; server: string[]; matches: boolean }
type Entry = { at: number; game: HostedGame | null };
const cache = new Map<string, Entry>();
const MAX_CACHED = 2000;

/** The version a game environment serves now: the live version of a live game, or the preview version. */
export function servedVersion(p: Pick<Project, 'status' | 'live_version' | 'preview_version'>, e: 'preview' | 'live'): number | null {
  if (p.status === 'removed') return null;
  return e === 'live' ? (p.status === 'live' ? p.live_version : null) : p.preview_version;
}

/** The server-side modules of a version (server/ and shared/ .js files): what a Dynamic Worker for it is built from. */
export function serverModules(files: string | null | undefined): { server: string[]; hasServer: boolean; matches: boolean } {
  const server = parseJson<{ path: string }[]>(files || '[]', []).map((f) => f.path)
    .filter((p) => (p.startsWith('server/') || p.startsWith('shared/')) && /\.m?js$/.test(p));
  return { server, hasServer: server.includes('server/index.js'), matches: server.includes('server/match.js') };
}

export async function hostedGame(env: Env, origin: string, route: GameRoute, t = Date.now()): Promise<HostedGame | null> {
  const hit = cache.get(route.script);
  if (hit && t - hit.at < GAME_CACHE_MS) return hit.game;
  const p = await getProject(env, route.pid);
  const n = p ? servedVersion(p, route.env) : null;
  const v = p && n ? await getVersion(env, p.id, n) : null;
  let game: HostedGame | null = null;
  if (p && v) {
    const m = serverModules(v.files);
    game = { p, v, vars: await gameBindings(env, origin, p, v, route.env), server: m.hasServer ? m.server : [], matches: m.matches };
  }
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(route.script, { at: t, game });
  return game;
}
/** Forgets what this isolate knows about a game, so the next request reads it again (a deploy in this isolate). */
export function forgetGame(script: string): void { cache.delete(script); }

/** True for a request the game's server code answers: /api/… under the game, with or without the /~t/<token>/ prefix. */
export function isServerRequest(pathname: string): boolean {
  let path = pathname;
  try { path = decodeURIComponent(pathname); } catch { return false; }
  const tm = path.match(/^\/~t\/[A-Za-z0-9_.-]{16,4096}(\/.*)?$/);
  if (tm) path = tm[1] || '/';
  return path.startsWith('/api/');
}

/** The id a game's Dynamic Worker is cached under. Anything that changes its code or its fixed configuration (version,
    runtime, the outbound policy it was given) changes the id, so a new one is loaded; the same id is reused otherwise
    (Dynamic Workers are billed per id and code per day). */
export async function dynamicWorkerId(script: string, version: number, runtime: string, out: OutboundParams): Promise<string> {
  return `${script}:v${version}:${runtime}:${(await sha256(JSON.stringify(out))).slice(0, 12)}`;
}

/** What a game's Dynamic Worker is made of: the runtime, the game's server/ and shared/ modules, and placeholders for
    the modules it did not ship, exactly as a game Worker's upload (src/deploy.ts). */
export async function dynamicWorkerCode(env: Env, g: HostedGame): Promise<Record<string, string>> {
  const modules: Record<string, string> = {
    [GAME_MAIN_MODULE]: GAME_WORKER_SOURCE, 'gcp-intrinsics.js': GAME_INTRINSICS_SOURCE, 'match-core.js': GAME_MATCH_CORE_SOURCE,
    'server/index.js': 'export default null;\n', 'server/match.js': 'export default null;\n',
  };
  for (const path of g.server) {
    const obj = await env.FILES.get(verKey(g.p.id, g.v.n, path));
    if (obj) modules[path] = await obj.text();
  }
  return modules;
}

/** The Worker Loader binding and the loopback entrypoint the Dynamic Worker's fetch() goes through. */
export interface LoaderCtx {
  loader: WorkerLoader;
  outbound: (props: OutboundParams) => Fetcher;
}

/** The namespace the shared host dispatches into: the same interface as a Workers for Platforms namespace, so the
    errors players see (not deployed, over its limits, failed) are the ones src/dispatch.ts already gives. */
export function sharedNamespace(env: Env, ctx: ExecutionContext, origin: string, s: Settings, route: GameRoute, lc: LoaderCtx | null): Namespace {
  return {
    get: (name, _args, options) => ({
      fetch: async (req: Request) => {
        const g = await hostedGame(env, origin, route);
        if (!g) throw new Error(`Worker not found: ${name}`);
        if (g.server.length && isServerRequest(new URL(req.url).pathname)) {
          if (!lc) throw new Error('Game server code is not available: the LOADER binding is missing.');
          const out = outboundParams(route, origin, s.game_blocked_hosts);
          const id = await dynamicWorkerId(route.script, g.v.n, await runtimeHash(), out);
          const worker = lc.loader.get(id, async () => ({
            compatibilityDate: GAME_COMPAT_DATE, compatibilityFlags: GAME_COMPAT_FLAGS, mainModule: GAME_MAIN_MODULE,
            modules: await dynamicWorkerCode(env, g), env: g.vars, globalOutbound: lc.outbound(out),
          }));
          const limits = options?.limits;
          return worker.getEntrypoint(undefined, limits && (limits.cpuMs || limits.subRequests) ? { limits } : undefined).fetch(req);
        }
        // pages and files: the runtime in-process, reading this version's files straight from the bucket
        return handleGame(req, { FILES: env.FILES, ...g.vars }, ctx, route.base);
      },
    }),
  };
}

/** Serves one request for a game under GAME_HOST. `m` is matchGameRequest's answer (a host that is not a game is a 404). */
export async function serveSharedGame(req: Request, env: Env, ctx: ExecutionContext, m: GameMatch, origin: string, lc: LoaderCtx | null): Promise<Response> {
  const s = await getSettings(env);
  const ns: Namespace = m.script ? sharedNamespace(env, ctx, origin, s, m, lc) : { get: () => { throw new Error('Worker not found'); } };
  // limits only apply to the Dynamic Worker (creator code); the outbound policy is fixed when it is loaded
  return dispatchGame(req, {}, ns, s, m, origin);
}
