// Outbound Worker for games on Workers for Platforms. Every fetch() a game's Worker makes (its own server code, and
// the runtime's calls to the platform) passes through here once the dispatch namespace binding names this Worker as
// its outbound service. The dispatch Worker passes { game, env, script, platform, blocked } as the "gcp" parameter
// (src/hosting.ts outboundParams). Deployed on its own with outbound/wrangler.jsonc; unused while games are standard
// Workers. Kept free of platform imports so it can be deployed alone and tested directly (tests/hosting.mjs).

// The platform paths a game Worker has any reason to call: its runtime API and the public modules games import.
const PLATFORM_PATHS = ['/api/rt/', '/sdk/', '/kits/', '/vendor/', '/guides/', '/templates/'];

/** Decides one outbound request. Returns { allow, reason?, platform? }. */
export function outboundDecision(url, p = {}) {
  let u;
  try { u = new URL(url); } catch { return { allow: false, reason: 'Bad URL.' }; }
  const host = u.hostname.toLowerCase();
  for (const b of p.blocked || []) {
    if (host === b || host.endsWith('.' + b)) return { allow: false, reason: `Requests to ${b} are blocked for games on this platform.` };
  }
  if (p.platform) {
    let plat = null;
    try { plat = new URL(p.platform); } catch { /* no platform origin given */ }
    if (plat && u.host.toLowerCase() === plat.host.toLowerCase()) {
      if (!PLATFORM_PATHS.some((x) => u.pathname.startsWith(x))) return { allow: false, reason: `Game server code may call the platform only under ${PLATFORM_PATHS.join(', ')}.` };
      return { allow: true, platform: true };
    }
  }
  return { allow: true };
}

export default {
  async fetch(request, env) {
    const p = env.gcp || {};
    const d = outboundDecision(request.url, p);
    if (!d.allow) {
      console.log(JSON.stringify({ outbound: 'blocked', game: p.game, env: p.env, url: request.url.split('?')[0], reason: d.reason }));
      return Response.json({ error: d.reason, code: 'outbound_blocked' }, { status: 403 });
    }
    if (!d.platform) return fetch(request);
    // calls to the platform say which game made them, whatever the game's code put in the headers
    const r = new Request(request);
    r.headers.set('x-gcp-game', String(p.game || ''));
    r.headers.set('x-gcp-env', String(p.env || ''));
    return fetch(r);
  },
};
