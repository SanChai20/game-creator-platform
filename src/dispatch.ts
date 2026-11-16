// Dynamic dispatch: hands a game request to the game's Worker with the platform's per-game limits and outbound params.
// One code path for every host: the dispatch Worker (src/dispatcher.ts) calls it with the real dispatch namespace, the
// platform Worker calls it with an emulated namespace for the local driver (/__game/…), and health checks call it so
// the platform never has to reach a game host over the internet. See docs/workers-for-platforms.md.
import type { Env } from './env';
import { gameLimits, outboundParams, type GameMatch } from './hosting.ts';
import type { Settings } from './settings';

export type GameRoute = Extract<GameMatch, { script: string }>;
/** The part of a dispatch namespace binding the router uses; an emulation only has to provide this. */
export interface Namespace { get(name: string, args?: Record<string, unknown>, options?: DynamicDispatchOptions): { fetch(req: Request): Promise<Response> } }
type DispatchEnv = Pick<Env, 'GAME_OUTBOUND'> & { PUBLIC_ORIGIN?: string };
type DispatchSettings = Pick<Settings, 'game_cpu_ms' | 'game_subrequests' | 'game_blocked_hosts'>;

const page = (status: number, title: string, text: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d0f;color:#e8e4da;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px"><div><h1 style="font-size:22px;margin:0 0 6px">${title}</h1><p style="opacity:.7;margin:0">${text}</p></div>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

/** The options a game Worker is invoked with. The outbound params only go along when the namespace binding has an
    outbound Worker (GAME_OUTBOUND set), since the runtime refuses parameters the binding does not declare. */
export function dispatchOptions(env: DispatchEnv, s: DispatchSettings, m: GameRoute, platform: string): DynamicDispatchOptions {
  const limits = gameLimits(s);
  return { ...(limits.cpuMs || limits.subRequests ? { limits } : {}), ...(env.GAME_OUTBOUND ? { outbound: { gcp: outboundParams(m, platform, s.game_blocked_hosts) } } : {}) };
}

/** Sends one request to a game Worker. Never throws: a missing Worker is a 404, a Worker that hit its CPU or
    subrequest limit (or crashed) is a 503 that says so, for players and in the developer's logs. */
export async function dispatchGame(req: Request, env: DispatchEnv, ns: Namespace, s: DispatchSettings, m: GameMatch, platform: string): Promise<Response> {
  if (!m.script) return page(404, 'Not found', 'There is no game at this address.');
  let worker;
  try { worker = ns.get(m.script, {}, dispatchOptions(env, s, m, platform)); }
  catch (e) { return failure(e, m, req); }
  try { return await worker.fetch(req); }
  catch (e) { return failure(e, m, req); }
}

function failure(e: unknown, m: GameRoute, req: Request): Response {
  const msg = String((e as Error)?.message || e);
  const api = new URL(req.url).pathname.startsWith('/api/');
  const out = (status: number, code: string, title: string, text: string) => api ? Response.json({ error: text, code }, { status, headers: { 'cache-control': 'no-store' } }) : page(status, title, text);
  if (/worker not found/i.test(msg)) return out(404, 'not_deployed', 'This game is not deployed', 'It may have been taken offline. Open it again from its page on the platform.');
  const limit = /cpu|exceeded|too many subrequests|limit/i.test(msg);
  console.error(JSON.stringify({ dispatch: 'failed', script: m.script, limit, error: msg.slice(0, 300) }));
  if (limit) return out(503, 'limit_exceeded', 'The game is over its limits', 'This game used more CPU time or made more requests than the platform allows for one request.');
  return out(502, 'game_failed', 'The game failed to answer', 'Try again in a moment.');
}

/** Fetches a URL of a game from inside the platform: in-process through the namespace when the URL is on the
    dispatch host (a Worker cannot count on reaching another Worker on the same zone over HTTP), plain fetch otherwise. */
export async function gameFetch(url: string, route: GameMatch | null, ns: Namespace | null, env: DispatchEnv, s: DispatchSettings, platform: string, init?: RequestInit): Promise<Response> {
  if (route && route.script && ns) return dispatchGame(new Request(url, init), env, ns, s, route, platform);
  return fetch(url, init);
}
