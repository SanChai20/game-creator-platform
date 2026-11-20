// Where game Workers live and how requests reach them, behind one small interface, so moving the games from standard
// Workers to Workers for Platforms (a dispatch namespace) is a configuration change. See docs/workers-for-platforms.md.
//
//   DEPLOY_DRIVER = "cloudflare"  each game is a standard Worker in the account (today). Reached on workers.dev, or on
//                                 <script>.<GAME_HOST> through a per-script route when GAME_HOST and GAME_ZONE_ID are set.
//   DEPLOY_DRIVER = "dispatch"    each game is a user Worker in the DISPATCH_NAMESPACE dispatch namespace. Reached on
//                                 <script>.<GAME_HOST>: a wildcard route sends those hosts to the dispatch Worker
//                                 (src/dispatcher.ts, dispatcher/wrangler.jsonc), which calls DISPATCHER.get(script, …)
//                                 with the per-game limits and outbound params.
//   DEPLOY_DRIVER = "shared"      no Worker per game: the platform Worker itself answers on *.<GAME_HOST> (a wildcard
//                                 route) and serves every game with the same runtime, in-process for its files and
//                                 pages, and runs a game's server code as a Dynamic Worker (src/game-host.ts). Games with
//                                 server-run matches (server/match.js) still get a standard Worker on a per-script route,
//                                 which is more specific than the wildcard. See docs/shared-game-host.md.
//   DEPLOY_DRIVER = "local"       wrangler dev: no upload; the platform Worker runs the game runtime itself at
//                                 /__game/<pid>/<env>/, through the same dispatch code with an emulated namespace.
//
// Pure: no bindings or I/O here (tests/hosting.mjs imports it directly). The I/O lives in deploy.ts and dispatch.ts.
import type { Env } from './env';

export type GameEnv = 'preview' | 'live';
export type HostKind = 'workers' | 'dispatch' | 'shared' | 'local';
type HostEnv = Pick<Env, 'DEPLOY_DRIVER'> & Partial<Pick<Env, 'DISPATCH_NAMESPACE' | 'GAME_HOST' | 'GAME_ZONE_ID' | 'PUBLIC_ORIGIN'>>;

export function hostKind(env: HostEnv): HostKind {
  const d = String(env.DEPLOY_DRIVER || 'cloudflare').toLowerCase();
  return d === 'local' ? 'local' : d === 'dispatch' || d === 'wfp' ? 'dispatch' : d === 'shared' ? 'shared' : 'workers';
}

/** Where a script lives, as stored in game_workers.host: "workers" (standard Worker on workers.dev), "workers:<GAME_HOST>"
    (standard Worker on a per-script route), "dispatch:<namespace>" or "local". Scripts whose host differs from the
    configured one are redeployed by the rollout (that is the migration) and the old copy retired. */
export function hostId(env: HostEnv): string {
  const k = hostKind(env);
  if (k === 'dispatch') return `dispatch:${env.DISPATCH_NAMESPACE || ''}`;
  if (k === 'shared') return `shared:${gameHostName(env)}`;
  if (k === 'workers' && gameHostName(env) && env.GAME_ZONE_ID) return `workers:${gameHostName(env)}`;
  return k;
}
export interface HostRef { kind: HostKind; namespace?: string; routeHost?: string }
export function parseHostId(id: string | null | undefined): HostRef {
  const s = String(id || 'workers');
  if (s.startsWith('dispatch:')) return { kind: 'dispatch', namespace: s.slice(9) };
  if (s.startsWith('workers:')) return { kind: 'workers', routeHost: s.slice(8) };
  if (s.startsWith('shared:')) return { kind: 'shared', routeHost: s.slice(7) };
  return { kind: s === 'local' ? 'local' : 'workers' };
}

/** Where a game with server-run matches lives while the configured host is "shared": a standard Worker on its own
    route under GAME_HOST (a Durable Object class per match needs a script of its own). Any other host keeps all games. */
export function matchHostId(env: HostEnv): string {
  if (hostKind(env) !== 'shared') return hostId(env);
  return gameHostName(env) && env.GAME_ZONE_ID ? `workers:${gameHostName(env)}` : 'workers';
}

/** What is missing for the configured host to work, in words an admin can act on. Empty when it is ready. */
export function hostingProblems(env: HostEnv & { DISPATCHER?: unknown; LOADER?: unknown }): string[] {
  const k = hostKind(env), out: string[] = [];
  if (k === 'dispatch') {
    if (!env.DISPATCH_NAMESPACE) out.push('DISPATCH_NAMESPACE is not set.');
    if (!gameHostName(env)) out.push('GAME_HOST is not set (games are served at <script>.<GAME_HOST> by the dispatch Worker).');
    if (!env.DISPATCHER) out.push('The DISPATCHER dispatch namespace binding is missing (health checks go through it).');
  }
  if (k === 'shared') {
    if (!gameHostName(env)) out.push('GAME_HOST is not set (the shared game host answers on *.<GAME_HOST>).');
    if (!env.LOADER) out.push('The LOADER Worker Loader binding is missing (games with server code run as Dynamic Workers).');
    if (!env.GAME_ZONE_ID) out.push('GAME_ZONE_ID is not set (games with server-run matches keep a per-script route on GAME_HOST).');
  }
  if (k === 'workers' && env.GAME_ZONE_ID && !gameHostName(env)) out.push('GAME_ZONE_ID is set without GAME_HOST.');
  return out;
}

// ----- script names and tags ---------------------------------------------------------------------------------------
// One name per game and environment, the same in every host. It is also the first label of the game's hostname, so a
// dispatch Worker can route a request with no lookup. Project ids are [a-z0-9]{6,16}, so a name is at most 27 characters.
const NAME = /^gcp-([a-z0-9]{6,16})-(preview|live)$/;
export const scriptName = (pid: string, e: GameEnv) => `gcp-${pid}-${e}`;
export function parseScriptName(name: string): { pid: string; env: GameEnv } | null {
  const m = NAME.exec(String(name));
  return m ? { pid: m[1], env: m[2] as GameEnv } : null;
}

/** Tags every game script carries (Workers for Platforms allows 8; no "," or "&"). They let the platform list, filter
    and bulk-delete scripts per project, per creator or per environment, e.g. DELETE …/scripts?tags=owner-u_abc:yes. */
export function scriptTags(t: { pid: string; owner: string; env: GameEnv; server: boolean }): string[] {
  const safe = (s: string) => String(s).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  return ['gcp-game', `gcp-${t.env}`, `project-${safe(t.pid)}`, `owner-${safe(t.owner)}`, t.server ? 'server-code' : 'static'];
}
export const projectTag = (pid: string) => `project-${pid}`;
export const ownerTag = (owner: string) => `owner-${String(owner).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)}`;

// ----- the script itself -------------------------------------------------------------------------------------------
export const GAME_COMPAT_DATE = '2026-10-01';
// disallow_importable_env: the game's own server modules share the isolate with the runtime, and must not reach its
// bindings (the whole games bucket, the play key) through `import { env } from 'cloudflare:workers'` or process.env.
// They only ever get the narrow env the runtime hands them. User Workers in a dispatch namespace get the same flags.
export const GAME_COMPAT_FLAGS = ['disallow_importable_env'];
export const GAME_MAIN_MODULE = 'game-worker.js';

/** Per-request limits for game Workers. 0 means the plan default. The same numbers are enforced on both hosts: in the
    upload metadata of a standard Worker, and through dispatcher.get(…, { limits }) for a user Worker. */
export interface GameLimits { cpuMs?: number; subRequests?: number }
export function gameLimits(s: { game_cpu_ms?: number; game_subrequests?: number }): GameLimits {
  const out: GameLimits = {};
  const cpu = Math.round(Number(s.game_cpu_ms) || 0), sub = Math.round(Number(s.game_subrequests) || 0);
  if (cpu > 0) out.cpuMs = Math.min(cpu, 300000);
  if (sub > 0) out.subRequests = Math.min(sub, 10000000);
  return out;
}
/** The limits in the shape the standard Workers upload API takes. */
export function metadataLimits(l: GameLimits): { cpu_ms?: number; subrequests?: number } | undefined {
  if (!l.cpuMs && !l.subRequests) return undefined;
  return { ...(l.cpuMs ? { cpu_ms: l.cpuMs } : {}), ...(l.subRequests ? { subrequests: l.subRequests } : {}) };
}

export type Binding = { type: 'plain_text' | 'secret_text'; name: string; text: string }
  | { type: 'durable_object_namespace'; name: string; class_name: string };
/** The bindings of a game script: plain text, secret text, and (for games with server-run matches) the script's own
    GameMatch Durable Object class, all supported on user Workers too. Never a bucket: the game's server code shares
    the isolate with the runtime, so anything bound here is within reach of the creator's code. The runtime reads the
    bundle through the platform (/api/rt/file), which opens only this game's own files. */
export function scriptBindings(vars: Record<string, string>, matches = false): Binding[] {
  const out: Binding[] = [];
  for (const [name, text] of Object.entries(vars)) out.push({ type: name === 'PLAY_KEY' || name === 'STORE_KEY' ? 'secret_text' : 'plain_text', name, text });
  if (matches) out.push({ type: 'durable_object_namespace', name: 'MATCH', class_name: MATCH_CLASS });
  return out;
}

// ----- server-run matches ------------------------------------------------------------------------------------------
// A game whose bundle has server/match.js gets a Durable Object class in its own script (GameMatch, exported by the
// runtime), one object per match. Durable Object classes are created by a migration in the upload metadata, and a
// migration may only be sent once per script: the platform reads the script's current migration tag and sends the
// migration only when the script does not have it yet. Once a script has the class it keeps the binding, even if a
// later version drops server/match.js (the runtime then answers that the game has no match code).
export const MATCH_CLASS = 'GameMatch';
export const MATCH_MIGRATION_TAG = 'gcp-match-v1';
export function matchSetup(currentTag: string | null | undefined, hasMatchCode: boolean): { binding: boolean; migrations?: Record<string, unknown> } {
  if (currentTag === MATCH_MIGRATION_TAG) return { binding: true };
  if (!hasMatchCode) return { binding: false };
  return { binding: true, migrations: currentTag ? { old_tag: currentTag, new_tag: MATCH_MIGRATION_TAG, new_sqlite_classes: [MATCH_CLASS] } : { new_tag: MATCH_MIGRATION_TAG, new_sqlite_classes: [MATCH_CLASS] } };
}

/** The upload metadata of a game script, for either host. */
export function scriptMetadata(kind: HostKind, o: { bindings: Binding[]; tags: string[]; limits: GameLimits; migrations?: Record<string, unknown> }): Record<string, unknown> {
  const limits = kind === 'workers' ? metadataLimits(o.limits) : undefined;   // a dispatch namespace takes them per request
  return {
    main_module: GAME_MAIN_MODULE, compatibility_date: GAME_COMPAT_DATE, compatibility_flags: GAME_COMPAT_FLAGS,
    bindings: o.bindings, tags: o.tags, observability: { enabled: true }, ...(limits ? { limits } : {}), ...(o.migrations ? { migrations: o.migrations } : {}),
  };
}

/** Cloudflare API path of the scripts collection of a host. */
export function scriptsPath(host: HostRef): string {
  if (host.kind === 'shared') throw new Error('The shared game host has no scripts.');
  if (host.kind === 'dispatch') {
    if (!host.namespace) throw new Error('DISPATCH_NAMESPACE is not set.');
    return `/workers/dispatch/namespaces/${encodeURIComponent(host.namespace)}/scripts`;
  }
  return '/workers/scripts';
}

// ----- addresses ---------------------------------------------------------------------------------------------------
const isLocalHost = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h) || /\.localhost(:\d+)?$/i.test(h);
const schemeFor = (h: string) => (isLocalHost(h) ? 'http' : 'https');
/** The host games are served under when GAME_HOST is set (e.g. "play.example.com", or "localhost:8787" in dev). */
export const gameHostName = (env: HostEnv) => String(env.GAME_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** The URL a game is played at, for a script in the given host. `subdomain` is the account's workers.dev subdomain. */
export function gameUrlFor(env: HostEnv, host: HostRef, script: string, o: { origin: string; subdomain?: string }): string {
  if (host.kind === 'shared') {
    const gh = host.routeHost || gameHostName(env);
    if (!gh) throw new Error('GAME_HOST is not set: the shared game host serves games at <script>.<GAME_HOST>.');
    return `${schemeFor(gh)}://${script}.${gh}/`;
  }
  if (host.kind === 'dispatch') {
    const gh = gameHostName(env);
    if (!gh) throw new Error('GAME_HOST is not set: games in a dispatch namespace are reached through <script>.<GAME_HOST>.');
    return `${schemeFor(gh)}://${script}.${gh}/`;
  }
  if (host.kind === 'workers') {
    if (host.routeHost) return `${schemeFor(host.routeHost)}://${script}.${host.routeHost}/`;
    if (!o.subdomain) throw new Error('workers.dev subdomain unknown');
    return `https://${script}.${o.subdomain}.workers.dev/`;
  }
  // local: a path on the platform origin (wrangler dev serves static assets before the Worker on any other path)
  const n = parseScriptName(script)!;
  return `${o.origin}/__game/${n.pid}/${n.env}/`;
}

export type GameMatch =
  | { script: string; pid: string; env: GameEnv; base: string; via: 'host' | 'path' }
  | { script: null };   // under the game host but not a game: answer 404, never the platform

/** Which game a request is for, if any. Host routing (<script>.<GAME_HOST>) is how the dispatch Worker
    (src/dispatcher.ts) and the shared game host (src/game-host.ts) receive every game request; path routing (/__game/<pid>/<env>/) is the local driver's. */
export function matchGameRequest(env: HostEnv, url: URL): GameMatch | null {
  const gh = gameHostName(env), host = url.host.toLowerCase();
  if (gh && host.endsWith('.' + gh)) {
    const label = host.slice(0, -(gh.length + 1));
    const n = !label.includes('.') ? parseScriptName(label) : null;
    return n ? { script: label, pid: n.pid, env: n.env, base: '', via: 'host' } : { script: null };
  }
  if (hostKind(env) === 'local') {
    const m = /^\/__game\/([a-z0-9]{6,16})\/(preview|live)(?=\/|$)/.exec(url.pathname);
    if (m) return { script: scriptName(m[1], m[2] as GameEnv), pid: m[1], env: m[2] as GameEnv, base: m[0], via: 'path' };
  }
  return null;
}


// ----- outbound ----------------------------------------------------------------------------------------------------
/** What the dispatch Worker tells the outbound Worker about each request (binding parameter "gcp"). */
export interface OutboundParams { game: string; env: GameEnv; script: string; platform: string; blocked: string[] }
export function outboundParams(m: { pid: string; env: GameEnv; script: string }, platform: string, blockedHosts: string): OutboundParams {
  const blocked = String(blockedHosts || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean).slice(0, 100);
  return { game: m.pid, env: m.env, script: m.script, platform, blocked };
}

/** How long a replaced script is kept after the game moved to another host, so sessions started on it can finish
    (play cookies last 6 hours). */
export const RETIRE_AFTER_MS = 6 * 3600 * 1000 + 15 * 60 * 1000;
