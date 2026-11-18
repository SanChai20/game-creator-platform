// Where game Workers live and how requests reach them, behind one small interface, so moving the games from standard
// Workers to Workers for Platforms (a dispatch namespace) is a configuration change. See docs/workers-for-platforms.md.
//
//   DEPLOY_DRIVER = "cloudflare"  each game is a standard Worker in the account (today). Reached on workers.dev, or on
//                                 <script>.<GAME_HOST> through a per-script route when GAME_HOST and GAME_ZONE_ID are set.
//   DEPLOY_DRIVER = "dispatch"    each game is a user Worker in the DISPATCH_NAMESPACE dispatch namespace. Reached on
//                                 <script>.<GAME_HOST>: a wildcard route sends those hosts to the dispatch Worker
//                                 (src/dispatcher.ts, dispatcher/wrangler.jsonc), which calls DISPATCHER.get(script, …)
//                                 with the per-game limits and outbound params.
//   DEPLOY_DRIVER = "local"       wrangler dev: no upload; the platform Worker runs the game runtime itself at
//                                 /__game/<pid>/<env>/, through the same dispatch code with an emulated namespace.
//
// Pure: no bindings or I/O here (tests/hosting.mjs imports it directly). The I/O lives in deploy.ts and dispatch.ts.
import type { Env } from './env';

export type GameEnv = 'preview' | 'live';
export type HostKind = 'workers' | 'dispatch' | 'local';
type HostEnv = Pick<Env, 'DEPLOY_DRIVER'> & Partial<Pick<Env, 'DISPATCH_NAMESPACE' | 'GAME_HOST' | 'GAME_ZONE_ID' | 'PUBLIC_ORIGIN'>>;

export function hostKind(env: HostEnv): HostKind {
  const d = String(env.DEPLOY_DRIVER || 'cloudflare').toLowerCase();
  return d === 'local' ? 'local' : d === 'dispatch' || d === 'wfp' ? 'dispatch' : 'workers';
}

/** Where a script lives, as stored in game_workers.host: "workers" (standard Worker on workers.dev), "workers:<GAME_HOST>"
    (standard Worker on a per-script route), "dispatch:<namespace>" or "local". Scripts whose host differs from the
    configured one are redeployed by the rollout (that is the migration) and the old copy retired. */
export function hostId(env: HostEnv): string {
  const k = hostKind(env);
  if (k === 'dispatch') return `dispatch:${env.DISPATCH_NAMESPACE || ''}`;
  if (k === 'workers' && gameHostName(env) && env.GAME_ZONE_ID) return `workers:${gameHostName(env)}`;
  return k;
}
export interface HostRef { kind: HostKind; namespace?: string; routeHost?: string }
export function parseHostId(id: string | null | undefined): HostRef {
  const s = String(id || 'workers');
  if (s.startsWith('dispatch:')) return { kind: 'dispatch', namespace: s.slice(9) };
  if (s.startsWith('workers:')) return { kind: 'workers', routeHost: s.slice(8) };
  return { kind: s === 'local' ? 'local' : 'workers' };
}

/** What is missing for the configured host to work, in words an admin can act on. Empty when it is ready. */
export function hostingProblems(env: HostEnv & { DISPATCHER?: unknown }): string[] {
  const k = hostKind(env), out: string[] = [];
  if (k === 'dispatch') {
    if (!env.DISPATCH_NAMESPACE) out.push('DISPATCH_NAMESPACE is not set.');
    if (!gameHostName(env)) out.push('GAME_HOST is not set (games are served at <script>.<GAME_HOST> by the dispatch Worker).');
    if (!env.DISPATCHER) out.push('The DISPATCHER dispatch namespace binding is missing (health checks go through it).');
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

export type Binding = { type: 'plain_text' | 'secret_text'; name: string; text: string } | { type: 'r2_bucket'; name: string; bucket_name: string };
/** The bindings of a game script. Plain text, secret text and one R2 bucket: all supported unchanged on user Workers. */
export function scriptBindings(vars: Record<string, string>, bucket: string): Binding[] {
  const out: Binding[] = [{ type: 'r2_bucket', name: 'FILES', bucket_name: bucket }];
  for (const [name, text] of Object.entries(vars)) out.push({ type: name === 'PLAY_KEY' || name === 'STORE_KEY' ? 'secret_text' : 'plain_text', name, text });
  return out;
}

/** The upload metadata of a game script, for either host. */
export function scriptMetadata(kind: HostKind, o: { bindings: Binding[]; tags: string[]; limits: GameLimits }): Record<string, unknown> {
  const limits = kind === 'workers' ? metadataLimits(o.limits) : undefined;   // a dispatch namespace takes them per request
  return {
    main_module: GAME_MAIN_MODULE, compatibility_date: GAME_COMPAT_DATE, compatibility_flags: GAME_COMPAT_FLAGS,
    bindings: o.bindings, tags: o.tags, observability: { enabled: true }, ...(limits ? { limits } : {}),
  };
}

/** Cloudflare API path of the scripts collection of a host. */
export function scriptsPath(host: HostRef): string {
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
    (src/dispatcher.ts) receives every game request; path routing (/__game/<pid>/<env>/) is the local driver's. */
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
